import { useState, useRef, useEffect, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Video, Upload, X, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { videoSenderApi, type VideoSenderProgressEvent, type VideoSenderResult } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './VideoSender.css';

// Rough, stage-based progress estimate — the backend reports discrete stages, not a byte-level
// percentage, so this is a UX approximation rather than a measured value.
const STAGE_PERCENT: Record<VideoSenderProgressEvent['stage'], number> = {
  queued: 5,
  uploading: 15,
  compressing: 45,
  recompressing: 60,
  sending: 75,
  'cleaning-up': 95,
  done: 100,
  failed: 100,
};

export function VideoSender() {
  const { t } = useTranslation();
  useDocumentTitle(t('videoSender.title'));
  const { canWrite } = useRole();
  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');

  const [session, setSession] = useState('');
  const [recipients, setRecipients] = useState('');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<VideoSenderProgressEvent | null>(null);
  const [result, setResult] = useState<VideoSenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  const recipientCount = recipients
    .split(',')
    .map(r => r.trim())
    .filter(Boolean).length;

  const isBusy = isSubmitting || (progress !== null && progress.stage !== 'done' && progress.stage !== 'failed');

  const isSendDisabled = !canWrite || isBusy || !session || !file || recipientCount === 0;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (picked) setFile(picked);
  };

  const handleSend = async () => {
    if (!session || !file || recipientCount === 0) return;

    const chatIds = recipients
      .split(',')
      .map(r => r.trim().replace(/\D/g, ''))
      .filter(Boolean)
      .map(n => `${n}@c.us`);

    setIsSubmitting(true);
    setResult(null);
    setError(null);
    setProgress(null);
    eventSourceRef.current?.close();

    try {
      const { jobId } = await videoSenderApi.start(session, file, chatIds, caption.trim() || undefined);

      const es = new EventSource(videoSenderApi.eventsUrl(session, jobId));
      eventSourceRef.current = es;

      es.onmessage = event => {
        const data = JSON.parse(event.data) as VideoSenderProgressEvent;
        setProgress(data);
        if (data.stage === 'done') {
          es.close();
          videoSenderApi
            .getResult(session, jobId)
            .then(setResult)
            .catch(err => setError(err instanceof Error ? err.message : t('videoSender.sendFailed')));
        } else if (data.stage === 'failed') {
          es.close();
          setError(data.message);
        }
      };

      es.onerror = () => {
        // The stream can close naturally right after 'done'/'failed' — only surface this as an
        // error if we never reached a terminal stage.
        if (progress && (progress.stage === 'done' || progress.stage === 'failed')) return;
        es.close();
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : t('videoSender.sendFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const percent = progress ? STAGE_PERCENT[progress.stage] : 0;

  if (loadingSessions) {
    return (
      <div className="video-sender" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="video-sender">
      <PageHeader title={t('videoSender.title')} subtitle={t('videoSender.subtitle')} />

      <div className="video-sender-panels">
        <div className="compose-panel">
          <h2 className="eyebrow">{t('videoSender.compose')}</h2>

          <div className="form-group">
            <label htmlFor="vs-session">{t('videoSender.session')}</label>
            <select id="vs-session" value={session} onChange={e => setSession(e.target.value)} disabled={isBusy}>
              {sessions.length === 0 && <option value="">{t('videoSender.noReadySessions')}</option>}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.phone || t('videoSender.sessionOptionPhoneNone')})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>{t('videoSender.video')}</label>
            {file ? (
              <div className="file-selected">
                <span className="file-name" title={file.name}>
                  {file.name} — {(file.size / (1024 * 1024)).toFixed(1)} MB
                </span>
                <button type="button" className="remove-file-btn" onClick={() => setFile(null)} disabled={isBusy}>
                  <X size={14} /> {t('videoSender.removeFile')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="browse-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={isBusy}
              >
                <Upload size={14} /> {t('videoSender.browse')}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <span className="hint">{t('videoSender.videoHint')}</span>
          </div>

          <div className="form-group">
            <label htmlFor="vs-recipients">{t('videoSender.recipients')}</label>
            <input
              id="vs-recipients"
              type="text"
              value={recipients}
              onChange={e => setRecipients(e.target.value)}
              placeholder="919876543210, 917877043782"
              disabled={isBusy}
            />
            <span className="hint">
              {t('videoSender.recipientsHint')} · {t('videoSender.recipientsCount', { count: recipientCount })}
            </span>
          </div>

          <div className="form-group">
            <label htmlFor="vs-caption">
              {t('videoSender.caption')} ({t('common.optional')})
            </label>
            <input
              id="vs-caption"
              type="text"
              value={caption}
              onChange={e => setCaption(e.target.value)}
              placeholder={t('videoSender.captionPlaceholder')}
              disabled={isBusy}
            />
          </div>

          <button className="send-btn" onClick={handleSend} disabled={isSendDisabled}>
            {isBusy ? <Loader2 className="animate-spin" size={18} /> : <Video size={18} />}
            {isBusy ? t('videoSender.sending') : canWrite ? t('videoSender.send') : t('videoSender.viewOnly')}
          </button>
        </div>

        <div className="response-panel">
          <h2 className="eyebrow">{t('videoSender.responseTitle')}</h2>

          {progress && (
            <div className="vs-progress">
              <div className="vs-progress-bar">
                <div
                  className={`vs-progress-fill ${progress.stage === 'failed' ? 'error' : ''}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="vs-progress-line">
                {progress.message}
                {progress.total !== undefined && progress.total > 1 && (
                  <> ({progress.sent}/{progress.total})</>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="response-status error">
              <XCircle size={20} />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <>
              <div className={`response-status ${result.results.every(r => r.success) ? 'success' : 'error'}`}>
                {result.results.every(r => r.success) ? <CheckCircle size={20} /> : <XCircle size={20} />}
                <span>{t('videoSender.compressedTo', { size: (result.compressedBytes / (1024 * 1024)).toFixed(1) })}</span>
              </div>
              <div className="response-details">
                {result.results.map(r => (
                  <div className="detail-row" key={r.chatId}>
                    <span className="detail-label">{r.chatId}</span>
                    <span className="detail-value" style={{ color: r.success ? 'var(--success)' : 'var(--error)' }}>
                      {r.success ? (r.messageId ?? t('videoSender.sentOk')) : r.error}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {!progress && !error && !result && (
            <div className="response-empty">
              <p>{t('videoSender.responseEmpty')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
