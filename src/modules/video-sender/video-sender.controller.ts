import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  Post,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { map, type Observable } from 'rxjs';
import { Public, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { VideoSenderService } from './video-sender.service';
import { SendVideoJobDto } from './dto/send-video.dto';
import { VideoSenderResponseDto } from './dto/video-sender-response.dto';

// Multer's default memory storage — the buffer never touches local disk, matching the
// "delete everything, keep nothing" requirement this feature was built around.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // generous — Cloudinary's own 100MB cap applies after compression

@ApiTags('video-sender')
@Controller('sessions/:sessionId/video-sender')
export class VideoSenderController {
  constructor(private readonly videoSenderService: VideoSenderService) {}

  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireRole(ApiKeyRole.OPERATOR)
  @UseInterceptors(FileInterceptor('video', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiOperation({
    summary:
      'Compress a video via Cloudinary and send it as a chat message to one or more recipients. ' +
      'Starts immediately in the background — subscribe to GET .../jobs/:jobId/events for live progress.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['video', 'chatIds'],
      properties: {
        video: { type: 'string', format: 'binary' },
        chatIds: { type: 'string', example: '628123456789@c.us,628999888777@c.us' },
        caption: { type: 'string' },
      },
    },
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 202, description: 'Job accepted', schema: { properties: { jobId: { type: 'string' } } } })
  send(
    @Param('sessionId') sessionId: string,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Body() dto: SendVideoJobDto,
  ): { jobId: string } {
    if (!file?.buffer) throw new BadRequestException('No video file uploaded (expected multipart field "video").');
    const jobId = this.videoSenderService.startJob(sessionId, file.buffer, dto.chatIds, dto.caption);
    return { jobId };
  }

  @Sse('jobs/:jobId/events')
  // No API key: the browser's native EventSource cannot send custom headers, so a guarded route
  // would be unreachable from it. Safe to leave public — jobId is an unguessable random UUID
  // acting as its own bearer token, and the stream only carries generic stage/progress text (no
  // media bytes, no credentials), for a job that self-expires 5 minutes after completion.
  @Public()
  @ApiOperation({ summary: 'Server-Sent Events stream of live progress for a video-sender job.' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'jobId', description: 'Job id returned by POST .../send' })
  watchJob(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return this.videoSenderService.watchJob(jobId).pipe(map(event => ({ data: event })));
  }

  @Get('jobs/:jobId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Fetch the final result of a completed job (compressed size + per-recipient outcome).' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'jobId', description: 'Job id returned by POST .../send' })
  @ApiResponse({ status: 200, type: VideoSenderResponseDto })
  getResult(@Param('jobId') jobId: string): VideoSenderResponseDto {
    return this.videoSenderService.getResult(jobId);
  }
}
