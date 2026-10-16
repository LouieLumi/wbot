import test from 'node:test';
import assert from 'node:assert/strict';
import {plainTextReply} from '../apps/server/src/hermes-style.js';

test('Hermes renders formatted prose as plain text with readable line breaks',()=>{
  assert.equal(plainTextReply('# 今日计划\n\n> **先休息**，再来 _试试_！\n- [x] ~~完成热身~~\n- [ ] 喝水\n* 放松\n1. 第一项\n2) 第二项\n\n---'),
    '今日计划\n\n先休息，再来 试试！\n已完成：完成热身\n待办：喝水\n放松\n1、第一项\n2、第二项');
});
test('Hermes keeps source URLs and inline code literal while removing Markdown wrappers',()=>{
  assert.equal(plainTextReply('**[官网](https://example.com/a_(b))**'), '官网 https://example.com/a_(b)');
  assert.equal(plainTextReply('[资料](https://example.com/a_(b)?some_key=x_y#part)\n[参考][a]\n[a]: https://example.com/one_two\n`foo_bar` 和 `a * b`，**重点**。\nhttps://example.com/__name__/a_b_c\n![苹果](https://example.com/apple.png)'),
    '资料 https://example.com/a_(b)?some_key=x_y#part\n参考 https://example.com/one_two\nfoo_bar 和 a * b，重点。\nhttps://example.com/__name__/a_b_c\n苹果 https://example.com/apple.png');
});
test('Hermes preserves code bodies, indentation, formulas and command names',()=>{
  const code='def foo_bar(x):\n    # Keep this comment\n    return x * 2\n\n\n# Literal heading in code';
  assert.equal(plainTextReply('```python\n'+code+'\n```'),code);
  assert.equal(plainTextReply('```\n    indented_code\n```'),'    indented_code');
  assert.equal(plainTextReply('a_b_c，x * y * z，2*3*4，/newimg 和 C#。'), 'a_b_c，x * y * z，2*3*4，/newimg 和 C#。');
});
test('Hermes converts a Markdown table into labelled plain-text records',()=>{
  assert.equal(plainTextReply('| 项目 | 状态 |\n| --- | :---: |\n| **阅读** | 完成 |\n| 喝水 | 继续 |'), '项目：阅读；状态：完成\n项目：喝水；状态：继续');
  assert.equal(plainTextReply('a | b\n这个竖线不构成表格'), 'a | b\n这个竖线不构成表格');
});
