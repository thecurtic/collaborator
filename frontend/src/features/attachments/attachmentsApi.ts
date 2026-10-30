import { request, requestStream, uploadForm } from '@/api/http';
import type { ApiAttachment } from '@/api/types';
import { toAttachment } from '@/domain/adapters';
import type { Attachment } from '@/domain/models';

export const attachmentsApi = {
  /** Upload one file; it comes back at once, its text still being read. */
  async upload(
    file: File | Blob,
    filename: string,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<Attachment> {
    const form = new FormData();
    form.append('file', file, filename);
    const res = await uploadForm<{ attachment: ApiAttachment }>('/api/attachments', form, {
      signal,
      onProgress,
    });
    return toAttachment(res.attachment);
  },

  /** One attachment with its extracted text. */
  async get(id: number): Promise<Attachment> {
    const res = await request<{ attachment: ApiAttachment }>(`/api/attachments/${id}`);
    return toAttachment(res.attachment);
  },

  /** The file's bytes (authenticated: no bare <img src> in the Android shell). */
  async file(id: number): Promise<Blob> {
    const res = await requestStream(`/api/attachments/${id}/file`);
    return res.blob();
  },

  /** Read it again (after a failure, or once a vision model is loaded);
   *  for audio and video, transcribe it. */
  async extract(id: number): Promise<Attachment> {
    const res = await request<{ attachment: ApiAttachment }>(
      `/api/attachments/${id}/extract`,
      { method: 'POST' },
    );
    return toAttachment(res.attachment);
  },

  /** Discard an upload that was never sent. */
  async remove(id: number): Promise<void> {
    await request(`/api/attachments/${id}`, { method: 'DELETE' });
  },
};

/** Object URLs for attachment files, by id (attachments never change). */
const urls = new Map<number, Promise<string>>();

export function attachmentUrl(id: number): Promise<string> {
  let p = urls.get(id);
  if (!p) {
    p = attachmentsApi.file(id).then((b) => URL.createObjectURL(b));
    p.catch(() => urls.delete(id));
    urls.set(id, p);
  }
  return p;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Audio or video, by type or (when the picker gives none) by extension:
 *  the files a hold on send transcribes. */
export function isMediaFile(type: string, name: string): boolean {
  return (
    /^(audio|video)\//.test(type) ||
    /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac|amr|3gp|webm|mp4|m4v|mov|mkv|avi)$/i.test(name)
  );
}
