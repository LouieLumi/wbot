import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseArticle, translateRich, ArticleError, articleUrl, type Article} from '../apps/link-publisher/src/articles.js';
import {extractBlocks, richChannelParts, type RichTranslation} from '../apps/link-publisher/src/layout.js';
import {readImage, imageFile} from '../apps/link-publisher/src/media.js';
import {ChannelApi} from '../apps/link-publisher/src/client.js';
import {LinkPublisher, type PublisherPorts} from '../apps/link-publisher/src/publisher.js';
import {JSDOM} from 'jsdom';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII=', 'base64');
const image = (name: string) => ({kind: 'image' as const, image: {url: `https://example.com/${name}.png`, alt: name}});
const rich: RichTranslation = {title: '自写的花园记录', blocks: [
  {kind: 'heading', level: 2, text: '第一天'}, {kind: 'paragraph', text: '这是第一段正文。'}, image('first'),
  {kind: 'paragraph', text: '这是第二段正文。'}, image('second'), {kind: 'list', number: 1, text: '观察记录。'},
]};

test('article extraction retains headings, numbered lists, captions and image positions', () => {
  const paragraph = 'Our original garden experiment records the color of each flower and the amount of water used. '.repeat(4);
  const article = parseArticle(Buffer.from(`<html><head><title>Garden</title></head><body><nav><img src="/logo.png"></nav><article>
    <h1>Garden</h1><p>${paragraph}</p><figure><img data-src="/flower.png" alt="First flower"><figcaption>A new flower.</figcaption></figure>
    <h2>Measurements</h2><ol start="3"><li>Water the plants.</li><li>Measure the plants.</li></ol><blockquote>Take careful notes.</blockquote>
    <p>${paragraph}</p><pre>const value = 1;\nconsole.log(value);</pre></article></body></html>`), 'text/html', 'https://example.com/story');
  const blocks = article.blocks!;
  assert.equal(blocks[1]!.kind, 'image');
  assert.deepEqual(blocks[1], {kind: 'image', image: {url: 'https://example.com/flower.png', alt: 'First flower'}});
  assert.deepEqual(blocks[2], {kind: 'paragraph', text: 'A new flower.'});
  assert(blocks.some(b => b.kind === 'heading' && b.text === 'Measurements'));
  assert.deepEqual(blocks.filter(b => b.kind === 'list').map(b => b.kind === 'list' && b.number), [3, 4]);
  assert(blocks.some(b => b.kind === 'quote')); assert(blocks.some(b => b.kind === 'code' && b.text.includes('\n')));
  assert(!JSON.stringify(blocks).includes('logo.png'));
});

test('image extraction handles lazy src, srcset, relative URLs and rejects tracking pixels/private URLs', () => {
  const fragment = JSDOM.fragment(`<p>Before<img src="data:image/png;base64,AAAA" data-src="../full.png" alt="Full">After</p>
    <picture><source srcset="/small.webp 200w, /large.webp 1600w"><img src="/fallback.png"></picture>
    <img width="1" height="1" src="/pixel.png"><img src="http://127.0.0.1/secret"><img src="file:///secret">`);
  const blocks = extractBlocks(fragment, 'https://example.com/path/story', 'Title', articleUrl);
  assert.deepEqual(blocks.filter(b => b.kind === 'image').map(b => b.kind === 'image' && b.image.url),
    ['https://example.com/full.png', 'https://example.com/large.webp']);
  assert.deepEqual(blocks.filter(b => b.kind === 'paragraph').map(b => b.kind === 'paragraph' && b.text), ['Before', 'After']);
});

test('structured translation validates every ID and leaves images and code unchanged', async () => {
  const article: Article = {url: 'https://example.com/story', title: 'Our title', text: 'Our paragraph.', blocks: [
    {kind: 'heading', level: 2, text: 'Our heading'}, image('flower'), {kind: 'paragraph', text: 'Our paragraph.'},
    {kind: 'code', text: 'const text = "unchanged";'},
  ]};
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'gemini-3.8-flash-high');
    assert.equal(body.reasoning_effort, 'high'); assert.equal(body.tools, undefined);
    const input = JSON.parse(body.messages[1].content).items;
    assert.deepEqual(input.map((x: any) => x.id), ['title', '0:0', '2:0']);
    assert(!JSON.stringify(body.messages).includes('flower.png'));
    return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({translations:
      input.map((item: any) => ({id: item.id, text: '译文' + item.text}))})}}]});
  };
  const result = await translateRich(article, {baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'test',
    model: 'gemini-3.8-flash-high', reasoningEffort: 'high'}, request);
  assert.equal(result.title, '译文Our title');
  assert.deepEqual(result.blocks[1], article.blocks![1]); assert.deepEqual(result.blocks[3], article.blocks![3]);
  for (const bad of [{translations: []}, {translations: [{id: 'wrong', text: '错位'}]}])
    await assert.rejects(translateRich(article, {baseUrl: 'http://localhost/v1', apiKey: 'test', model: 'test'},
      async () => Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(bad)}}]})), /translation_incomplete/);
});

test('long structured translations keep every block, chunk and image and retry only a failed batch', async () => {
  const blocks = Array.from({length: 90}, (_, i) => ({kind: 'paragraph' as const, text: `Paragraph ${i}: ` + 'A self-authored garden experiment. '.repeat(20)}));
  const article: Article = {url: 'https://example.com/story', title: 'Title', text: blocks.map(b => b.text).join('\n'), blocks: [...blocks, image('last')]};
  const captured: any[] = []; let calls = 0;
  const result = await translateRich(article, {baseUrl: 'http://localhost/v1', apiKey: 'test', model: 'test'}, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const input = JSON.parse(body.messages[1].content).items;
    if (++calls === 2) return Response.json({error: {}}, {status: 503});
    assert(Buffer.byteLength(JSON.stringify(input)) <= 14000); captured.push(...input);
    return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({translations: input})}}]});
  }, {sleep: async () => {}});
  assert(calls > 2); assert.equal(result.blocks.length, 91);
  for (const [i, block] of blocks.entries()) assert.equal((result.blocks[i] as typeof block).text, block.text.trim(), `block ${i}`);
  assert.deepEqual(result.blocks.at(-1), image('last')); assert.equal(captured.length, 91);
});

test('native image sections retain reading order, formatting and bounded fallback payloads', () => {
  const parts = richChannelParts('https://example.com/story', rich);
  assert.equal(parts.length, 3); assert.match(parts[0]!.content, /^# 自写的花园记录/);
  assert.match(parts[0]!.content, /## 第一天/); assert.match(parts[2]!.content, /1\. 观察记录/);
  assert.deepEqual(parts.map(p => p.images.map(i => i.alt)), [['first'], ['second'], []]);
  assert(parts[0]!.content.includes('第一段') && !parts[0]!.content.includes('第二段'));
  assert(parts[1]!.content.includes('第二段'));
  const oversized = richChannelParts('https://example.com/' + 's'.repeat(3900), {title: 'Long', blocks: [
    {kind: 'paragraph', text: '文'.repeat(18000)}, {kind: 'image', image: {url: 'https://example.com/' + 'i'.repeat(3900), alt: '图'.repeat(500)}},
  ]});
  assert(oversized.every(p => Buffer.byteLength(p.content + (p.images.length ? '\n\n配图：' + p.images[0]!.alt + '\n' + p.images[0]!.url : '')) <= 20480));
  assert.equal(oversized.map(p => p.content).join('').split('文').length - 1 - (oversized.length - 1), 18001); // body plus source label
});

test('image downloads validate redirects and bytes, never treating HTML/SVG as images', async () => {
  const good = await readImage('https://example.com/a', async () => ({body: png, type: 'image/png'}));
  assert.deepEqual(good.body, png); assert.equal(good.filename, 'article-image.png');
  let calls = 0;
  await assert.rejects(readImage('https://example.com/a', async () => {calls++; return {body: Buffer.alloc(0), type: '', redirect: 'http://127.0.0.1/private'};}), /unsafe_url/);
  assert.equal(calls, 1);
  assert.throws(() => imageFile(Buffer.from('<svg><script>bad()</script></svg>')), /image_format/);
  assert.throws(() => imageFile(Buffer.alloc(10_000_001)), /image_size/);
});

test('native media uploads preserve bytes and the root/reply image payload', async () => {
  const body = Buffer.concat([png, Buffer.alloc(600_000)]), chunks: Buffer[] = [], sent: any[] = [];
  const api = new ChannelApi({bot_id: 'test', secret: 'test'}, async (url, init) => {
    const path = new URL(String(url)).pathname, payload = JSON.parse(String(init?.body));
    if (path.endsWith('/get_token')) return Response.json({errcode: 0, access_token: 'test-token'});
    if (path.endsWith('/upload_media_init')) {assert.equal(payload.type, 'image'); assert.equal(payload.total_chunks, 2); return Response.json({errcode: 0, upload_id: 'upload'});}
    if (path.endsWith('/upload_media_chunk')) {assert.equal(payload.chunk_index, chunks.length); chunks.push(Buffer.from(payload.base64_data, 'base64')); return Response.json({errcode: 0});}
    if (path.endsWith('/upload_media_finish')) return Response.json({errcode: 0, media_id: 'image-id'});
    sent.push(payload); return Response.json({errcode: 0, post_id: 'post', reply_id: 'reply'});
  });
  const id = await api.uploadImage({body, filename: 'test.png'}); assert.deepEqual(Buffer.concat(chunks), body);
  await api.publish('topic', '# 标题', undefined, [id]); await api.publish('topic', '续文', 'post', [id]);
  assert.deepEqual(sent[0], {topic_id: 'topic', content: '# 标题', image_list: [{media_id: 'image-id'}]});
  assert.equal(sent[1].post_id, 'post'); assert.deepEqual(sent[1].image_list, sent[0].image_list);
});

test('prepared image sections survive restart and a failed image becomes a positioned link with a notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-rich-')), path = join(dir, 'db');
  const events: string[] = [], sent: {text: string; root?: string; images?: string[]}[] = []; let enabled = true;
  const ports: PublisherPorts = {
    enabled: () => enabled, read: async url => ({url, title: 'Test', text: 'Test'}),
    translate: async () => {enabled = false; return rich;},
    uploadImage: async image => {events.push('upload-' + image.alt); if (image.alt === 'second') throw new ArticleError('image_network'); return 'media-' + image.alt;},
    verifyChannel: async () => {}, publish: async (text, root, images) => {events.push('publish'); sent.push({text, root, images}); return root ? 'reply' : 'root';},
    verifyPost: async (_id, content, count) => {assert.equal(content, sent[0]!.text); assert.equal(count, 1); return true;},
    notify: async () => 'sent', pause: async () => {},
  };
  let publisher = new LinkPublisher(path, '频道', ['alice'], ports, 0);
  const receive = (id: string, content: string) => publisher.receive({message_id: id, user_id: 'alice', content, timestamp: Date.now(), chat_type: 'private'});
  try {
    receive('link', 'https://example.com/story'); receive('confirm', '确认'); await publisher.runNext(); assert.equal(sent.length, 0);
    publisher.close(); enabled = true; publisher = new LinkPublisher(path, '频道', ['alice'], ports, 0);
    await publisher.runNext(); assert.deepEqual(events.slice(0, 2), ['upload-first', 'upload-second']);
    assert.deepEqual(sent[0]!.images, ['media-first']); assert.deepEqual(sent[1]!.images, []);
    assert(sent.slice(1).every(p => p.root === 'root')); assert(sent[1]!.text.includes('第二段正文。') && sent[1]!.text.includes('https://example.com/second.png'));
    const notices = publisher.db.prepare('SELECT content FROM notices').all() as {content: string}[];
    assert(notices.some(n => n.content.includes('1 张配图') && n.content.includes('原图链接')));
  } finally {publisher.close(); rmSync(dir, {recursive: true});}
});

test('legacy plain-text parts migrate without losing pending data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-migration-')), path = join(dir, 'db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE parts(job_id TEXT,ordinal INTEGER,content TEXT,state TEXT,remote_id TEXT); INSERT INTO parts VALUES('legacy',0,'保留正文','queued','')"); db.close();
  const ports = {} as PublisherPorts; const publisher = new LinkPublisher(path, '频道', [], ports);
  try {
    const part = publisher.db.prepare('SELECT * FROM parts').get() as any;
    assert.equal(part.content, '保留正文'); assert.equal(part.images, '[]'); assert.equal(part.delivery_content, '');
  } finally {publisher.close(); rmSync(dir, {recursive: true});}
});
