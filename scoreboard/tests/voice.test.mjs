import test from 'node:test';
import assert from 'node:assert/strict';
import {koreanNumber, scoreCall} from '../public/voice.js';

test('voice: Korean numbers', () => {
  assert.deepEqual([0, 1, 9, 10, 11, 15, 20, 21, 29, 30].map(koreanNumber),
    ['영', '일', '구', '십', '십일', '십오', '이십', '이십일', '이십구', '삼십']);
});

test('voice: full call reads every number, server first', () => {
  assert.equal(scoreCall(11, 7, 'full'), '십일 대 칠');
  assert.equal(scoreCall(0, 0, 'full'), '영 대 영');
  assert.equal(scoreCall(21, 19, 'full'), '이십일 대 십구');
});

test('voice: short call drops the 십 of the tens only', () => {
  assert.equal(scoreCall(11, 7, 'short'), '일, 칠');
  assert.equal(scoreCall(10, 12, 'short'), '영, 이');
  assert.equal(scoreCall(19, 9, 'short'), '구, 구');
  assert.equal(scoreCall(20, 18, 'short'), '이십, 팔');
});
