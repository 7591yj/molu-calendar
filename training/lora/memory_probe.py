#!/usr/bin/env python3
"""기억 프로브: 앱이 조립한 프롬프트(카드+예시+참고 자료+질문)를 로컬 Qwen3로 실행한다.

목적은 프롬프트 구조의 검증이다. 앱의 실제 모델(Gemma 4 LiteRT)이 아니라 로컬 Qwen3-1.7B를 쓰므로
이 결과를 앱 품질 보장으로 주장하지 않는다. 앱과 같은 조립 코드는
training/lora/build_memory_probes.mjs가 만든 prompts.jsonl에 들어 있다.

    node training/lora/build_memory_probes.mjs training/lora/runs/memory-probe/prompts.jsonl
    cd training/lora && uv run --locked python memory_probe.py
"""
import argparse
import json
import time
from pathlib import Path

# 앱이 Worker에 넘기는 샘플링 설정과 맞춘다(local-ai-worker.js).
SEED = 42
TEMPERATURE = 0.6
TOP_P = 0.9


def score(row, text):
    includes = row['expect'].get('includes') or []
    excludes = row['expect'].get('excludes') or []
    hit = any(keyword in text for keyword in includes) if includes else None
    leaked = any(keyword in text for keyword in excludes) if excludes else None
    return hit, leaked


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompts', type=Path, default=Path('runs/memory-probe/prompts.jsonl'))
    parser.add_argument('--out', type=Path, default=None)
    parser.add_argument('--model', default='Qwen/Qwen3-1.7B')
    parser.add_argument('--revision', default='70d244cc86ccca08cf5af4e1e306ecf908b1ad5e')
    parser.add_argument('--device', default='mps')
    parser.add_argument('--adapter', type=Path, default=None, help='선택: PEFT 어댑터 경로(실험용)')
    parser.add_argument('--limit', type=int, default=0, help='선택: 앞에서 N건만 실행')
    parser.add_argument('--filter', default=None, help='선택: id에 이 문자열이 포함된 프롬프트만 실행(예: yuuka)')
    parser.add_argument('--max-new-tokens', type=int, default=128)
    args = parser.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed

    rows = [json.loads(line) for line in args.prompts.read_text(encoding='utf-8').splitlines() if line.strip()]
    if args.filter:
        rows = [row for row in rows if args.filter in row['id']]
    if args.limit:
        rows = rows[:args.limit]
    if not rows:
        raise SystemExit('조건에 맞는 프롬프트가 없습니다.')
    tokenizer = AutoTokenizer.from_pretrained(args.model, revision=args.revision)
    model = AutoModelForCausalLM.from_pretrained(args.model, revision=args.revision, dtype=torch.bfloat16)
    if args.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter)
    model = model.to(args.device).eval()
    model.config.use_cache = True

    out_dir = args.out or args.prompts.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    responses = out_dir / 'responses.jsonl'
    summary = out_dir / 'summary.md'
    totals = {}
    with responses.open('w', encoding='utf-8') as handle:
        for index, row in enumerate(rows):
            ids = tokenizer.apply_chat_template(row['messages'], tokenize=True, add_generation_prompt=True, enable_thinking=False)
            inputs = torch.tensor([ids], device=args.device)
            set_seed(SEED)
            started = time.monotonic()
            with torch.inference_mode():
                generated = model.generate(
                    input_ids=inputs, attention_mask=torch.ones_like(inputs), max_new_tokens=args.max_new_tokens,
                    do_sample=True, temperature=TEMPERATURE, top_p=TOP_P, pad_token_id=tokenizer.pad_token_id,
                    eos_token_id=tokenizer.eos_token_id)[0, len(ids):].tolist()
            text = tokenizer.decode(generated, skip_special_tokens=True).strip()
            hit, leaked = score(row, text)
            record = {'id': row['id'], 'characterId': row['characterId'], 'variant': row['variant'], 'question': row['question'],
                      'reference': row['reference'], 'promptChars': row['promptChars'], 'promptTokens': len(ids),
                      'response': text, 'hit': hit, 'leaked': leaked, 'hit_token_limit': tokenizer.eos_token_id not in generated,
                      'seconds': round(time.monotonic() - started, 2), 'adapter': str(args.adapter) if args.adapter else None}
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
            handle.flush()
            bucket = totals.setdefault(row['variant'], {'n': 0, 'hit': 0, 'leak': 0, 'truncated': 0, 'seconds': 0.0})
            bucket['n'] += 1
            bucket['hit'] += int(hit is True)
            bucket['leak'] += int(leaked is True)
            bucket['truncated'] += int(record['hit_token_limit'])
            bucket['seconds'] += record['seconds']
            print(f"[{index + 1}/{len(rows)}] {row['id']} {'hit' if hit else 'leak' if leaked else 'miss'} "
                  f"({record['seconds']}s, {len(ids)} tokens)", flush=True)

    lines = ['# 기억 프로브 결과', '',
             f'- 모델: `{args.model}` @ `{args.revision}`' + (f' + 어댑터 `{args.adapter}`' if args.adapter else ''),
             f'- 장치: `{args.device}`, 샘플링: seed {SEED}, temperature {TEMPERATURE}, top_p {TOP_P}, 최대 {args.max_new_tokens}토큰',
             '- 프롬프트: 앱의 `chatMessagesWithReferences()`가 조립한 카드+예시+참고 자료+질문',
             '- 이 결과는 프롬프트 구조 검증이며, 앱 모델(Gemma 4 LiteRT)의 품질 보장이 아니다.', '',
             '| 변형 | 건수 | 기억 반영(hit) | 유출/환각(leak) | 토큰 한도 도달 | 평균 초 |',
             '|---|---:|---:|---:|---:|---:|']
    for variant, bucket in totals.items():
        lines.append(f"| {variant} | {bucket['n']} | {bucket['hit']} | {bucket['leak']} | {bucket['truncated']} | {bucket['seconds'] / bucket['n']:.1f} |")
    lines += ['', '## 답변', '']
    for line in responses.read_text(encoding='utf-8').splitlines():
        record = json.loads(line)
        flag = '기억 반영' if record['hit'] else '유출' if record['leaked'] else '중립'
        lines.append(f"### {record['id']} ({record['variant']}, {flag})")
        lines.append(f"- 질문: {record['question']}")
        lines.append(f"- 참고: {', '.join(record['reference']) if record['reference'] else '없음'}")
        lines.append(f"- 답변: {record['response']}")
        lines.append('')
    summary.write_text('\n'.join(lines), encoding='utf-8')
    print('저장:', responses, summary)


if __name__ == '__main__':
    main()
