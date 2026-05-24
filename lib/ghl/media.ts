// GHL Media library upload. Used by the parent portal to push uploaded
// documents into the school's GHL location so school staff can see them
// natively inside their CRM.
//
// Endpoint: POST /medias/upload-file (multipart/form-data)
// Returns:  { fileId, url }
//
// The returned URL is a public CDN link (CloudFront / filesafe.space).
// We then attach it to a Conversations message on the parent's contact
// so it appears in their conversation thread.

import FormData from 'form-data';
import type { GhlClient } from './client';

export interface UploadedMedia {
  fileId: string;
  url: string;
}

export async function uploadMediaToGhl(
  client: GhlClient,
  opts: {
    filename: string;
    mimeType: string;
    contents: Buffer;
  },
): Promise<UploadedMedia> {
  const fd = new FormData();
  fd.append('file', opts.contents, {
    filename: opts.filename,
    contentType: opts.mimeType,
  });
  fd.append('name', opts.filename);
  // hosted=false uploads to the location's own media bucket (CDN-hosted,
  // public URL). True would mark as private — we want public so the
  // attachment URL works in conversations messages.
  fd.append('hosted', 'false');
  fd.append('parentId', '');

  const { data } = await client.axios.post<{
    fileId: string;
    url: string;
  }>(
    '/medias/upload-file',
    fd,
    { headers: { ...fd.getHeaders() } },
  );
  if (!data.fileId || !data.url) {
    throw new Error('GHL media upload returned without fileId / url');
  }
  return { fileId: data.fileId, url: data.url };
}
