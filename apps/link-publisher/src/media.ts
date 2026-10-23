import {ArticleError, articleUrl, fetchPublicPage, requestAddress, resolvePublic, type PageResponse} from './articles.js';

export type ArticleMedia = {body: Buffer; filename: string};
export function imageFile(body: Buffer): ArticleMedia {
  if (!body.length || body.length > 10_000_000) throw new ArticleError('image_size');
  let extension = '';
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
  else if (body[0] === 255 && body[1] === 216 && body[2] === 255) extension = 'jpg';
  else if (/^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))) extension = 'gif';
  else if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') extension = 'webp';
  if (!extension) throw new ArticleError('image_format');
  return {body, filename: 'article-image.' + extension};
}
export async function readImage(input: string, transfer: (url: URL) => Promise<PageResponse> = url =>
  fetchPublicPage(url, resolvePublic, (url, address, timeout) => requestAddress(url, address, timeout, true))): Promise<ArticleMedia> {
  let url = articleUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await transfer(url);
    if (!response.redirect) return imageFile(response.body);
    url = articleUrl(new URL(response.redirect, url).href);
  }
  throw new ArticleError('too_many_redirects');
}
