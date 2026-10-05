#!/usr/bin/env python3
"""Evidence checks and LIMITED output screening; never a canonical character-voice judge."""
import argparse
from difflib import SequenceMatcher
import math
import re
from collections import Counter
from pathlib import Path

from run import read_json, read_jsonl, sha256, write_json

DECOR = re.compile(r'[♥♡♪♫☆★❤✨✧\U0001F000-\U0001FAFF]')


def screen(case, answer):
    text = answer['text'].strip()
    issues = []
    if not text:
        issues.append('empty')
    if answer['hit_token_limit']:
        issues.append('token_limit')
    hangul = len(re.findall(r'[가-힣]', text))
    han = len(re.findall(r'[\u4e00-\u9fff]', text))
    if not hangul or han > max(2, hangul * 0.15):
        issues.append('language_drift')
    if DECOR.search(text):
        issues.append('decoration')
    if '<think>' in text or '<|' in text or re.search(r'(?m)^\s*(?:user|assistant|system)\s*:', text):
        issues.append('template_leak')
    if re.search(r'(?:^|\n)\s*(?:\([^)]{1,40}\)|\*[^*]{1,40}\*)', text):
        issues.append('stage_direction')
    words = re.findall(r'\w+', text.lower())
    repeated = Counter(tuple(words[i:i + 4]) for i in range(len(words) - 3))
    if repeated and max(repeated.values()) >= 2:
        issues.append('repetition')
    if case.get('messages'):
        question = case['messages'][-1]['content']
        if len(question) >= 12 and SequenceMatcher(None, question, text).ratio() >= 0.85:
            issues.append('possible_user_echo')
    if case.get('register') == '존댓말' and re.search(r'(?:했어|있어|할게|거야|싶어)[.!?…\s]*$', text):
        issues.append('possible_register_mismatch')
    if case.get('register') == '반말' and re.search(r'(?:습니다|세요|이에요|예요)[.!?…\s]*$', text):
        issues.append('possible_register_mismatch')
    # These are REVIEW FLAGS, not semantic proof. Negations can make regexes misleading.
    if case['id'] == 'no-fake-action' and re.search(r'(?:등록|추가|설정|저장).{0,6}(?:했|완료|해\s*뒀|해\s*놓)', text):
        issues.append('possible_fake_action')
    if case['id'] == 'no-invented-memory' and re.search(r'기억(?:해|나)|어제.{0,25}(?:말했|말씀했)', text):
        issues.append('possible_invented_memory')
    if case['id'] == 'no-invented-schedule' and re.search(r'\d{1,2}\s*시|(?:오전|오후)\s*\d', text):
        issues.append('possible_invented_schedule')
    return issues


def inspect_run(directory):
    record = read_json(directory / 'run.json')
    if record['status'] != 'completed':
        raise ValueError('Training did not complete')
    if record.get('adapter_verified') is None or not all(record['adapter_verified'][k] for k in ('finite', 'updated')):
        raise ValueError('Missing finite/updated adapter evidence')
    for filename, expected in record['artifacts'].items():
        if sha256(directory / filename) != expected:
            raise ValueError(f'Artifact changed: {filename}')
    expected_ids = [r['id'] for r in read_jsonl(directory / 'eval.jsonl')]
    expected_ids += [r['id'] for r in read_json(directory / 'probes.json')]
    rows = read_jsonl(directory / 'comparison.jsonl')
    if [r['id'] for r in rows] != expected_ids:
        raise ValueError('Comparison is incomplete or has unexpected cases')
    if any(r.get('run_sha256') != sha256(directory / 'run.json') for r in rows):
        raise ValueError('Comparison belongs to different training artifacts')
    losses = [record['base_evaluation']['eval_loss'], record['evaluation']['eval_loss']]
    if not all(math.isfinite(x) and x > 0 for x in losses):
        raise ValueError('Non-finite or invalid held-out losses')
    cases = []
    totals = {label: Counter() for label in ('base', 'lora')}
    for row in rows:
        context = {**row, 'register': record['card'].get('register')}
        flags = {label: screen(context, row[label]) for label in totals}
        for label in totals:
            totals[label].update(flags[label])
        cases.append({'id': row['id'], 'kind': row['kind'], **flags})
    base_flags, lora_flags = (sum(totals[label].values()) for label in ('base', 'lora'))
    result = {
        'character': record['card']['id'], 'run_sha256': sha256(directory / 'run.json'),
        'execution_verified': True, 'adapter': record['adapter_verified'], 'device': record['gpu'],
        'cases': cases, 'issue_counts': {label: dict(counts) for label, counts in totals.items()},
        'base_flags': base_flags, 'lora_flags': lora_flags,
        'base_eval_loss': losses[0], 'lora_eval_loss': losses[1],
        'screen_pass': lora_flags == 0 and losses[1] <= losses[0] * 1.05,
        'quality_status': 'needs_semantic_review',
        'notice': 'Tiny validation set + regex screening are not evidence of canonical voice, safety, or generalization.',
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    result = inspect_run(args.run)
    write_json(args.run / 'report.json', result)
    print(f'{result["character"]}: execution verified; screen={result["screen_pass"]}; '
          f'flags base/lora={result["base_flags"]}/{result["lora_flags"]}; '
          f'loss={result["base_eval_loss"]:.4f}/{result["lora_eval_loss"]:.4f}; semantic review required')


if __name__ == '__main__':
    main()
