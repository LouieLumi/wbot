import {createHash, randomUUID} from 'node:crypto';
import {imageFile, type ArticleMedia} from './media.js';

export type Credentials = {bot_id: string; secret: string};
export class WecomError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); }
}

/** No automatic retries of visible writes: a lost response may still mean delivery. */
export class ChannelApi {
  private token = '';
  private expires = 0;
  constructor(private credentials: Credentials, private request = fetch) {}
  private async post(operation: string, body: object, token = '', visible = false): Promise<any> {
    try {
      const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/aibot/' + operation);
      if (token) url.searchParams.set('access_token', token);
      const response = await this.request(url, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)});
      if (!response.ok) throw new WecomError('wecom_http_' + response.status, visible && response.status >= 500);
      const data = await response.json() as any;
      if (typeof data.errcode !== 'number') throw new WecomError('wecom_invalid_response', visible);
      if (data.errcode !== 0) throw new WecomError('wecom_' + data.errcode);
      return data;
    } catch (error) {
      if (error instanceof WecomError) throw error;
      throw new WecomError('wecom_network_or_response', visible);
    }
  }
  private async accessToken() {
    if (this.token && Date.now() < this.expires) return this.token;
    const time = Math.floor(Date.now() / 1000), nonce = randomUUID().replaceAll('-', '');
    const signature = createHash('sha256')
      .update(this.credentials.secret + this.credentials.bot_id + time + nonce).digest('hex');
    const data = await this.post('get_token', {bot_id: this.credentials.bot_id, time, nonce, signature});
    if (typeof data.access_token !== 'string' || !data.access_token) throw new WecomError('wecom_missing_token');
    this.token = data.access_token; this.expires = Date.now() + 86_300_000;
    return this.token;
  }
  async verifyChannel(topicId: string, name: string) {
    const data = await this.post('topic/get_topic_list', {type: 0, topic_id_list: [topicId]}, await this.accessToken());
    if (!data.topic_list?.some((topic: any) => topic.topic_id === topicId && topic.topic_name === name))
      throw new WecomError('channel_destination_mismatch');
  }
  async uploadImage(media: ArticleMedia): Promise<string> {
    const {body, filename} = imageFile(media.body), token = await this.accessToken();
    const chunkSize = 512 * 1024, totalChunks = Math.ceil(body.length / chunkSize);
    const started = await this.post('upload_media_init', {type: 'image', filename,
      total_size: body.length, total_chunks: totalChunks, md5: createHash('md5').update(body).digest('hex')}, token);
    if (typeof started.upload_id !== 'string' || !started.upload_id) throw new WecomError('wecom_missing_upload_id');
    for (let index = 0; index < totalChunks; index++) await this.post('upload_media_chunk', {
      upload_id: started.upload_id, chunk_index: index,
      base64_data: body.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64'),
    }, token);
    const finished = await this.post('upload_media_finish', {upload_id: started.upload_id}, token);
    if (typeof finished.media_id !== 'string' || !finished.media_id) throw new WecomError('wecom_missing_media_id');
    return finished.media_id;
  }
  async publish(topicId: string, content: string, postId?: string, imageIds: string[] = []): Promise<string> {
    if (!content.trim() || Buffer.byteLength(content) > 20_480) throw new WecomError('channel_content_size');
    if (imageIds.length > 8 || imageIds.some(id => typeof id !== 'string' || !id)) throw new WecomError('channel_image_count');
    const data = await this.post(postId ? 'topic/send_reply' : 'topic/send_post',
      {topic_id: topicId, content, ...(postId ? {post_id: postId} : {}),
        ...(imageIds.length ? {image_list: imageIds.map(media_id => ({media_id}))} : {})}, await this.accessToken(), true);
    const id = postId ? data.reply_id : data.post_id;
    if (typeof id !== 'string' || !id) throw new WecomError('wecom_missing_delivery_id', true);
    return id;
  }
  async verifyPost(topicId: string, postId: string, content: string, imageCount = 0) {
    const data = await this.post('topic/get_post_list',
      {topic_id: topicId, type: 0, post_id_list: [postId]}, await this.accessToken());
    return Boolean(data.post_list?.some((p: any) => p.post_id === postId && p.content === content &&
      (p.image_list?.length ?? 0) === imageCount &&
      ((p.creator ?? p.creator_info)?.aibotid ?? (p.creator ?? p.creator_info)?.botid) === this.credentials.bot_id));
  }
}
