import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { ReplaySubject, type Observable } from 'rxjs';
import { MessageService } from '../message/message.service';
import { SessionService } from '../session/session.service';
import { VideoSenderRecipientResultDto, VideoSenderResponseDto } from './dto/video-sender-response.dto';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How long to wait after a send before deleting the chat. WhatsApp's own message-sent event
 * re-syncs the local chat list with the just-sent message's timestamp, which can otherwise race
 * an immediate deleteChat call and leave the chat looking untouched. Not a guaranteed fix — it
 * narrows the race rather than closing it outright, since the exact re-sync timing isn't
 * something this service controls.
 */
const CHAT_DELETE_DELAY_MS = 8_000;

/** Cloudinary's free-plan hard cap per video asset. */
const CLOUDINARY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Mirrors 1.BAT's "Vertical Status" preset as closely as Cloudinary's transformation API allows:
 * pad to exactly 1080x1920 (matching the .BAT's `pad=1080:1920:(ow-iw)/2:(oh-ih)/2` letterboxing,
 * not just a bounding-box resize), explicit h264/aac (matching `-c:v libx264 ... -c:a aac`), and a
 * numeric quality near the .BAT's `-crf 24` rather than a vague "auto" heuristic.
 */
const PRIMARY_TRANSFORM = {
  width: 1080,
  height: 1920,
  crop: 'pad',
  background: 'black',
  quality: 80,
  video_codec: 'h264',
  audio_codec: 'aac',
  fps: '24-30',
};

/** Only used if the primary pass still lands at/over the 100MB cap — trades quality for headroom. */
const FALLBACK_TRANSFORM = {
  width: 720,
  height: 1280,
  crop: 'pad',
  background: 'black',
  quality: 60,
  video_codec: 'h264',
  audio_codec: 'aac',
  fps: '24-30',
};

export type VideoSenderJobStage =
  | 'queued'
  | 'uploading'
  | 'compressing'
  | 'recompressing'
  | 'sending'
  | 'cleaning-up'
  | 'done'
  | 'failed';

export interface VideoSenderProgressEvent {
  jobId: string;
  stage: VideoSenderJobStage;
  message: string;
  /** Present once send-per-recipient progress is known. */
  sent?: number;
  total?: number;
  timestamp: number;
}

interface JobRecord {
  events$: ReplaySubject<VideoSenderProgressEvent>;
  result?: VideoSenderResponseDto;
  error?: string;
}

@Injectable()
export class VideoSenderService {
  private readonly logger = new Logger(VideoSenderService.name);
  private configured = false;
  private readonly jobs = new Map<string, JobRecord>();

  constructor(
    private readonly messageService: MessageService,
    private readonly sessionService: SessionService,
  ) {}

  private ensureConfigured(): void {
    if (this.configured) return;
    const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
    const api_key = process.env.CLOUDINARY_API_KEY;
    const api_secret = process.env.CLOUDINARY_API_SECRET;
    if (!cloud_name || !api_key || !api_secret) {
      throw new InternalServerErrorException(
        'Video sender is not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.',
      );
    }
    // The SDK's own request timeout defaults to 60s (an INACTIVITY timeout on the socket, not a
    // total-duration cap) — but the eager transform runs synchronously as part of the upload
    // response (eager_async: false), so Cloudinary can easily take longer than 60s to finish
    // transcoding and reply once our bytes are fully sent, with no traffic flowing in between.
    // Raised to 5 min, well past anything we've seen this clip size take.
    cloudinary.config({ cloud_name, api_key, api_secret, timeout: 300000 });
    this.configured = true;
  }

  private uploadBuffer(buffer: Buffer, eager: Record<string, unknown>): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'video', folder: 'video-sender', eager: [eager], eager_async: false, timeout: 300000 },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary upload error: ${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`);
            return reject(error ?? new Error('Cloudinary upload returned no result'));
          }
          resolve(result);
        },
      );
      const readable = Readable.from(buffer);
      readable.on('error', err => this.logger.error(`Source stream error: ${(err as Error).message}`));
      uploadStream.on('error', err => this.logger.error(`Upload stream error: ${(err as Error).message}`));
      readable.pipe(uploadStream);
    });
  }

  private reTransform(publicId: string, eager: Record<string, unknown>): Promise<UploadApiResponse> {
    return cloudinary.uploader.explicit(publicId, {
      type: 'upload',
      resource_type: 'video',
      eager: [eager],
      eager_async: false,
    }) as Promise<UploadApiResponse>;
  }

  private async destroy(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true });
    } catch (err) {
      this.logger.warn(`Failed to delete Cloudinary asset ${publicId}: ${(err as Error).message}`);
    }
  }

  /** Starts the job in the background and returns its id immediately for the caller to subscribe to. */
  startJob(sessionId: string, buffer: Buffer, chatIds: string[], caption: string | undefined): string {
    this.ensureConfigured();
    const jobId = randomUUID();
    // Unbounded replay buffer is safe here: a job emits only a handful of stage transitions total
    // before completing, so a client that connects to the SSE stream a moment after the job
    // started (the realistic dashboard flow: POST returns jobId, then open SSE) still gets every
    // earlier event immediately, not just what fires after it subscribes.
    const events$ = new ReplaySubject<VideoSenderProgressEvent>();
    this.jobs.set(jobId, { events$ });

    void this.runJob(jobId, sessionId, buffer, chatIds, caption);
    return jobId;
  }

  /** SSE stream for a job's progress. Completes the observable once the job reaches a terminal stage. */
  watchJob(jobId: string): Observable<VideoSenderProgressEvent> {
    const job = this.jobs.get(jobId);
    if (!job) throw new BadRequestException(`Unknown job id: ${jobId}`);
    return job.events$.asObservable();
  }

  private emit(jobId: string, stage: VideoSenderJobStage, message: string, extra?: Partial<VideoSenderProgressEvent>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const event: VideoSenderProgressEvent = { jobId, stage, message, timestamp: Date.now(), ...extra };
    job.events$.next(event);
    if (stage === 'done' || stage === 'failed') {
      job.events$.complete();
      // Keep the record around briefly for a late-joining SSE client to still get a final state;
      // a real deployment would want a TTL sweep here, but jobs are short-lived and low-volume.
      setTimeout(() => this.jobs.delete(jobId), 5 * 60_000);
    }
  }

  private async runJob(
    jobId: string,
    sessionId: string,
    buffer: Buffer,
    chatIds: string[],
    caption: string | undefined,
  ): Promise<void> {
    let publicId: string | undefined;
    try {
      this.emit(jobId, 'uploading', 'Uploading video to Cloudinary...');
      let upload = await this.uploadBuffer(buffer, PRIMARY_TRANSFORM);
      publicId = upload.public_id;
      let eager = upload.eager?.[0];
      this.emit(jobId, 'compressing', 'Compressing...');

      if (eager && eager.bytes >= CLOUDINARY_MAX_BYTES) {
        this.emit(jobId, 'recompressing', `First pass too large (${(eager.bytes / 1024 / 1024).toFixed(1)}MB) — compressing harder...`);
        upload = await this.reTransform(publicId, FALLBACK_TRANSFORM);
        eager = upload.eager?.[0];
      }

      if (!eager) throw new InternalServerErrorException('Cloudinary did not return a compressed video.');

      if (eager.bytes >= CLOUDINARY_MAX_BYTES) {
        throw new BadRequestException(
          `Video is too large even after compression (${(eager.bytes / 1024 / 1024).toFixed(1)}MB, cap is 100MB). ` +
            'Trim the clip or lower its source resolution before uploading.',
        );
      }

      const compressedUrl = eager.secure_url as string;
      const results: VideoSenderRecipientResultDto[] = [];

      for (let i = 0; i < chatIds.length; i++) {
        const chatId = chatIds[i];
        this.emit(jobId, 'sending', `Sending to ${chatId}...`, { sent: i, total: chatIds.length });
        try {
          const sent = await this.messageService.sendVideo(sessionId, { chatId, url: compressedUrl, caption });
          results.push({ chatId, success: true, messageId: sent.messageId });
          // Best-effort: clears the chat from OUR OWN chat list after a successful send (mirrors
          // the Cloudinary cleanup below) — matches "keep nothing" for the message thread itself,
          // not just the video bytes. Deletion here is one-sided: WhatsApp has no concept of
          // deleting a chat for the recipient too, only clearing it from the sender's own list.
          // A delete failure must not flip a successful send to a failure — log and move on.
          this.emit(jobId, 'sending', `Waiting before clearing chat with ${chatId}...`, {
            sent: i + 1,
            total: chatIds.length,
          });
          await sleep(CHAT_DELETE_DELAY_MS);
          try {
            await this.sessionService.deleteChat(sessionId, chatId);
          } catch (deleteErr) {
            this.logger.warn(`Failed to delete chat ${chatId} after send: ${(deleteErr as Error).message}`);
          }
        } catch (err) {
          results.push({ chatId, success: false, error: (err as Error).message });
        }
      }

      this.emit(jobId, 'cleaning-up', 'Deleting temporary copy from Cloudinary...', {
        sent: chatIds.length,
        total: chatIds.length,
      });
      await this.destroy(publicId);

      const job = this.jobs.get(jobId);
      if (job) job.result = { compressedBytes: eager.bytes as number, results };
      this.emit(jobId, 'done', 'Done.', { sent: chatIds.length, total: chatIds.length });
    } catch (err) {
      // Also log server-side, not just to the SSE stream — a client that never subscribed (or
      // disconnected before the failure) would otherwise leave zero trace of why the job died.
      this.logger.error(`Job ${jobId} failed: ${(err as Error).message}`, (err as Error).stack);
      if (publicId) await this.destroy(publicId);
      const job = this.jobs.get(jobId);
      if (job) job.error = (err as Error).message;
      this.emit(jobId, 'failed', (err as Error).message);
    }
  }

  getResult(jobId: string): VideoSenderResponseDto {
    const job = this.jobs.get(jobId);
    if (!job?.result) throw new BadRequestException('Job not complete or unknown.');
    return job.result;
  }
}
