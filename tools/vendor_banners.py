"""Match official KR/ZH banners to the schema-v1 wiki feed.

SchaleDB's localized student names join wiki pickup titles to Nexon KR notice
sections and CN recruitment news. KR event microsites supply additional OG art.
Ambiguous matches get no banner. JP events use the original title from
vendor_events.py's description field to find official JP news.

Matches update source_url as well as images; dates still come from wiki tables.
Unmatched GL events keep their wiki source because official KR/GL channels differ.

Run: python3 tools/vendor_banners.py [--report]
     --report lists matches without downloading or writing.
Writes: public/resource/events.json and public/resource/event_banner_img/*.webp
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vendor_events import jp_news, raid_assets, publish_events

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS = os.path.join(ROOT, 'public/resource', 'events.json')
BANNER_DIR = os.path.join(ROOT, 'public/resource', 'event_banner_img')
CN_NEWS = 'https://www.bluearchive-cn.com/api/news/list'
KR_SITEMAP = 'https://bluearchive.nexon.com/sitemap.xml'
KR_THREADS = 'https://forum.nexon.com/api/v1/board/1018/threads'
KR_THREAD = 'https://forum.nexon.com/api/v1/thread/{id}'
# 공식 출처 URL. 포럼 링크는 사이트가 og:url로 내보내는 주소 그대로, JP·CN은 각 사이트 라우터 경로.
KR_THREAD_URL = 'https://forum.nexon.com/bluearchive/board_view?board=1018&thread={id}'
CN_SITE = 'https://www.bluearchive-cn.com'
JP_NEWS_URL = 'https://bluearchive.jp/news/newsJump/{id}'
JP_NEWS_LIST = 'https://bluearchive.jp/news/newsJump'
SCHALEDB = 'https://schaledb.com/data/{loc}/students.json'
UA = 'molu-calendar-vendoring (fan project data build)'
BROWSER_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/120 Safari/537.36')
WEBP_QUALITY = '82'
KST = timezone(timedelta(hours=9))
# CN news sections that carry recruitment/event banners. 1 is the mixed feed, 2 the
# notes, 3 the notices (maintenance art), 4 the 预告 previews (限时招募 / 限时活动).
CN_TYPES = (1, 2, 3, 4)
# The forum API rejects anything without these: alias + countryCode identify the
# community, and paginationType/hideType/pageSize/blockSize are the board defaults
# from board_list.js. X-Requested-With is what jQuery's $.ajax sends.
FORUM_QUERY = ('alias=bluearchive&countryCode=KR&paginationType=PAGING'
               '&hideType=WEB&pageSize=30&blockSize=5')
FORUM_HEADERS = ['-H', 'X-Requested-With: XMLHttpRequest',
                 '-H', 'Referer: https://forum.nexon.com/bluearchive/board_list?board=1018',
                 '-H', f'User-Agent: {BROWSER_UA}',
                 '-H', 'Accept: application/json, text/javascript, */*; q=0.01']


def fetch(url, headers=None):
    """Body of one URL, read through a temp file so large responses are not clipped."""
    fd, path = tempfile.mkstemp(suffix='.body')
    os.close(fd)
    subprocess.run(['curl', '-sL', '--max-time', '90', '--retry', '3', '--retry-delay', '2',
                    '--retry-all-errors', '-A', UA, '-o', path, *(headers or []), url], check=False)
    with open(path, 'rb') as handle:
        body = handle.read()
    os.remove(path)
    if not body:
        sys.exit(f'empty response: {url}')
    return body.decode('utf-8', 'replace')


def fetch_json(url, headers=None):
    body = fetch(url, headers)
    try:
        return json.loads(body)
    except ValueError:
        sys.exit(f'not JSON ({len(body)} bytes, starts {body[:40]!r}): {url}')


def slug(value, limit=60):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', str(value).lower())).strip('-')[:limit] or 'x'


def student_names():
    """Map English names to KR/ZH using the live roster; the GitHub archive is incomplete."""
    tables = {loc: fetch_json(SCHALEDB.format(loc=loc)) for loc in ('en', 'kr', 'cn')}
    names = {}
    for id_, english in tables['en'].items():
        entry = {}
        for loc, lang in (('kr', 'kr'), ('cn', 'zh')):
            other = tables[loc].get(id_) or {}
            if other.get('Name'):
                entry[lang] = other['Name']
        if english.get('Name'):
            names[english['Name']] = entry
    return names


def localized(name, lang, names):
    return (names.get(name) or {}).get(lang)


# 위키와 SchaleDB가 같은 것을 다르게 부르는 이름. 양쪽 표기를 같은 토큰으로 접는다.
# 여기 없는 이름이 어긋나면 붙이지 않는다 — 억지로 맞추면 다른 학생 배너가 붙는다.
ALIASES = {
    'aris': 'arisu', 'arisu': 'arisu',
    'armed': 'battle', 'battle': 'battle',
    'pajamas': 'pajama', 'pajama': 'pajama',
    'bunnygirl': 'bunny', 'bunny': 'bunny',
}


def fold(text):
    key = re.sub(r'[^a-z0-9]', '', str(text).lower())
    return ALIASES.get(key, key)


def split_name(name):
    """'Azusa (Swimsuit)' -> ('Azusa', 'Swimsuit'); a plain name gets an empty variant."""
    match = re.match(r'([^(]+)(?:\(([^)]+)\))?', str(name))
    return match.group(1).strip(), match.group(2) or ''


def name_matches(schaledb_name, wiki_name):
    """Whether a SchaleDB name and one wiki title token are the same student.

    Comparing whole names is not enough: the wiki writes "Eimi (Battle)" where
    SchaleDB writes "Eimi (Armed)". The base name and the outfit both have to agree,
    and a plain name never matches an outfit variant of the same student.
    """
    if schaledb_name == wiki_name:
        return True
    base_a, variant_a = split_name(schaledb_name)
    base_b, variant_b = split_name(wiki_name)
    if fold(base_a) != fold(base_b):
        return False
    if not variant_a or not variant_b:
        return False
    return fold(variant_a) == fold(variant_b)


def title_students(title):
    """English student names a pickup title is about.

    "Azusa (Swimsuit) 외 9명 픽업" -> ["Azusa (Swimsuit)"]
    "Kikyou (Swimsuit), Renge (Swimsuit) 픽업 (복각)" -> both names
    """
    head = re.sub(r'\s*외\s*\d+명\s*', '', re.split(r'\s*픽업', title)[0])
    return [name.strip() for name in head.split(',') if name.strip()]


def cn_news_rows():
    """Every CN news row that has a banner, deduped by id."""
    rows = {}
    for type_id in CN_TYPES:
        # 복각 픽업은 CN이 먼저 돌린 판의 배너를 그대로 쓴다. 그래서 과거 공지까지 훑는다.
        for page in range(1, 51):
            url = f'{CN_NEWS}?pageIndex={page}&pageNum=40&type={type_id}'
            batch = (fetch_json(url).get('data') or {}).get('rows') or []
            for row in batch:
                if row.get('banner') and row.get('title'):
                    rows.setdefault(str(row['id']), row)
            if len(batch) < 40:
                break
    return list(rows.values())


def cn_visible(zh_name, title, absorbed_by):
    """Whether a row title really names this student, not merely contains her characters.

    짧은 중국어 이름은 다른 학생 이름 안에 그대로 들어간다 — 레이의 '丽'는 아리스의
    '爱丽丝' 안에 있다. 긴 이름에 먹힌 글자는 지우고, 남은 자리에 있을 때만 맞다고 본다.
    """
    for longer in absorbed_by:
        title = title.replace(longer, '')
    return zh_name in title


def match_cn(events, rows, names):
    """{event id: (student, news id, banner url)} — one CN recruitment banner per pickup."""
    zh_names = {entry['zh'] for entry in names.values() if entry.get('zh')}
    absorbed = {zh: [other for other in zh_names if other != zh and zh in other] for zh in zh_names}
    by_student = {}
    for row in rows:
        if '限时招募' not in row['title']:
            continue
        for english, entry in names.items():
            zh = entry.get('zh')
            if zh and zh in row['title'] and cn_visible(zh, row['title'], absorbed[zh]):
                by_student.setdefault(english, row)
    matched = {}
    for event in events:
        if event['category'] != 'pickup':
            continue
        for wiki_name in title_students(event['title']):
            row = next((by_student[e] for e in by_student if name_matches(e, wiki_name)), None)
            if row:
                matched[event['id']] = (wiki_name, str(row['id']), row['banner'])
                break
    return matched


SECTION = re.compile(r'(\d+)\)\s*((?:[^()★]{1,24}\(★\d(?:\s*,\s*[^)]{1,20})?\)\s*&?\s*)+)\s*(?:특별\s*)?픽업 모집')
STUDENT = re.compile(r'([^()★&]{1,24})\(★\d(?:\s*,\s*([^)]{1,20}))?\)')
IMAGE = re.compile(r'<img[^>]+src="([^"]+\.(?:png|jpe?g|webp))"')


def notice_banners(content):
    """[(korean student name, banner url)] from one pickup notice body.

    A section's banner is the image after its header and before the next header.
    The board's own 공지사항 banner sits before the first section and belongs to nobody —
    pairing a section with the image *before* its header hands every student the previous
    student's banner and the first student the notice banner.
    """
    marks = [(m.start(), 'img', m.group(1)) for m in IMAGE.finditer(content)]
    marks += [(m.start(), 'sec', m.group(0)) for m in SECTION.finditer(content)]
    marks.sort()
    out = []
    for index, (_, kind, value) in enumerate(marks):
        if kind != 'sec':
            continue
        end = next((at for at, mark, _ in marks[index + 1:] if mark == 'sec'), len(content))
        banner = next((url for at, mark, url in marks[index + 1:] if mark == 'img' and at < end), None)
        if not banner:
            continue
        clean = re.sub(r'<[^>]+>', '', value).replace('&amp;', '&').replace('&nbsp;', ' ')
        for name, variant in STUDENT.findall(clean):
            # ' [ 복각] 키쿄' 처럼 앞 공백과 복각 꼬리표가 붙어 오므로 먼저 다듬는다.
            # '니코(★3) 특별 픽업' 처럼 변형이 없는 학생은 이름만 쓴다.
            name = re.sub(r'^\[?\s*복각\s*\]?\s*', '', name.strip()).strip()
            if name:
                out.append((f'{name}({variant.strip()})' if variant.strip() else name, banner))
    return out


def kr_notices():
    """[thread id] of the 픽업 모집 notices on board 1018, newest first.

    pageNo alone 400s; the board pages by cursor, so every page after the first
    carries the blockStartNo and blockStartKey the previous response handed back.
    pageSize caps at 100, which already reaches past the vendoring window.
    """
    query = FORUM_QUERY.replace('pageSize=30', 'pageSize=100')
    ids, page, key, block = [], 1, None, None
    for _ in range(8):
        url = f'{KR_THREADS}?{query}&pageNo={page}'
        if key:
            url += f'&blockStartNo={block}&blockStartKey={key}'
        payload = fetch_json(url, FORUM_HEADERS)
        rows = payload.get('threads') or []
        if not rows:
            break
        ids += [row['threadId'] for row in rows if '픽업 모집' in row.get('title', '')]
        if not payload.get('blockStartKey'):
            break
        key = ','.join(payload['blockStartKey'])
        block = payload.get('blockStartNo')
        page += 1
    return ids


def match_kr_forum(events, names):
    """{event id: (student, notice url, banner url)} — one KR recruitment banner per pickup."""
    by_student = {}
    for thread_id in kr_notices():
        body = fetch_json(KR_THREAD.format(id=thread_id) + '?alias=bluearchive&countryCode=KR',
                          FORUM_HEADERS).get('content') or ''
        for korean, url in notice_banners(body):
            english = next((e for e, v in names.items() if v.get('kr') == korean), None)
            if english:
                by_student.setdefault(english, (thread_id, url))
    matched = {}
    for event in events:
        if event['category'] != 'pickup':
            continue
        for wiki_name in title_students(event['title']):
            payload = next((by_student[e] for e in by_student if name_matches(e, wiki_name)), None)
            if payload:
                matched[event['id']] = (wiki_name, KR_THREAD_URL.format(id=payload[0]), payload[1])
                break
    return matched


def kr_microsites():
    """[(slug, microsite url, korean banner url)] from the official event microsites.

    Each microsite ships one OG banner per locale; meta_ko.png is the Korean one, and
    the sitemap URL is the event's official page.
    """
    found = []
    for url in re.findall(r'<loc>([^<]+)</loc>', fetch(KR_SITEMAP)):
        if '/events/' not in url:
            continue
        match = re.search(r'(https://nxm-clw-cdn[^"\'\\ ]+/meta_ko\.(?:png|jpe?g|webp))', fetch(url))
        if match:
            found.append((url.rstrip('/').rsplit('/', 1)[-1], url.rstrip('/'), match.group(1)))
    return found


def match_kr_sites(events, sites):
    """{event id: (slug, microsite url, banner url)} — a microsite slug naming exactly one event.

    Microsite slugs are short and English (prayball, runaway). A slug that lands on
    more than one event is a series name (decagrammaton covers several raids) and is
    dropped: one banner must not stand in for four events.
    """
    matched = {}
    for slug_name, page_url, url in sites:
        if len(slug_name) < 6 or slug_name.startswith('update'):
            continue
        hits = [e for e in events if slug_name in re.sub(r'[^a-z0-9]', '', e['title'].lower())]
        if len(hits) == 1:
            matched[hits[0]['id']] = (slug_name, page_url, url)
    return matched


# 공식 뉴스와 비교할 때 무시하는 문자: 공백·ASCII 기호·CJK/전각 기호(「」【】〜！？ 등).
# 같은 일정을 위키는 '鉄道爆走事件 〜そして…', 공식 뉴스는 '鉄道爆走事件〜そして…'처럼 쓴다.
JP_NOISE = re.compile(r'[\s\u3000!-/:-@\[-`{-~\u3001-\u303f\uff01-\uff65]+')


def fold_jp(value):
    """비교용 열쇠: 공백·기호·대소문자를 지운다."""
    return JP_NOISE.sub('', str(value).lower())


def jp_title(event):
    """설명 끝의 일본어 원제: 'Rerun · 夏空のやくそく' -> '夏空のやくそく'."""
    description = re.sub(r'^(?:Rerun|Permanent)\s*·\s*', '', event.get('description', ''))
    return description.split(' · ')[-1].strip()


def jp_news_ids():
    """{접은 summary: 뉴스 id} — 이벤트를 알리는 JP 공식 뉴스(typeId 1=이벤트, 2=공지)."""
    found = {}
    for type_id in (1, 2):
        for page in range(1, 6):
            rows = jp_news(f'/list?typeId={type_id}&pageNum=100&pageIndex={page}').get('data', {}).get('rows') or []
            for row in rows:
                found.setdefault(fold_jp(row.get('summary') or ''), str(row['id']))
            if len(rows) < 100:
                break
    return found


def match_jp_news(events, news):
    """{event id: 공식 뉴스 URL} — JP 트랙 일정을 일본어 원제로 맞춘다.

    원제가 뉴스 제목에 통째로 들어갈 때만 붙인다. 설명 자리에 원제 대신 섹션 이름이
    들어간 총력전·캠페인 행은 이름이 짧아 우연히 걸릴 수 있으므로 최소 길이를 둔다.
    """
    matched = {}
    for event in events:
        if event['servers'] != ['jp']:
            continue
        folded = fold_jp(jp_title(event))
        if len(folded) < 4:
            continue
        hit = next((id_ for summary, id_ in news.items() if folded in summary), None)
        if hit:
            matched[event['id']] = JP_NEWS_URL.format(id=hit)
    return matched


def download(url, name):
    """Save one remote image as webp; returns the file name, or None on failure."""
    target = os.path.join(BANNER_DIR, f'{name}.webp')
    if os.path.exists(target):
        return f'{name}.webp'
    raw = os.path.join(BANNER_DIR, f'.{name}.src')
    # 한 번에 수십 장을 받으면 CDN이 간간이 끊는다. 재시도하지 않으면 조용히 빈 자리로 남는다.
    result = subprocess.run(['curl', '-sL', '--max-time', '120', '--retry', '3', '--retry-delay', '2',
                             '--retry-all-errors', '-A', UA, '-o', raw, url],
                            capture_output=True, check=False)
    if result.returncode or not os.path.exists(raw):
        return None
    if open(raw, 'rb').read(3) not in (b'\x89PN', b'\xff\xd8\xff'):
        os.remove(raw)
        return None
    if subprocess.run(['cwebp', '-q', WEBP_QUALITY, '-quiet', raw, '-o', target],
                      capture_output=True, check=False).returncode:
        os.remove(raw)
        return None
    os.remove(raw)
    return f'{name}.webp'


def attach(events, picked, lang, name_of):
    """Each match payload ends with its banner URL; return the number attached."""
    added = 0
    for id_, payload in picked.items():
        file = download(payload[-1], name_of(payload)[:70])
        if not file:
            print(f'  실패: {payload[-1]}')
            continue
        event = next(e for e in events if e['id'] == id_)
        event['images'] = {**event.get('images', {}), lang: file}
        added += 1
    return added


def selftest():
    """Pure-function checks for the matching rules; no network. `--selftest`."""
    assert slug('Azusa (Swimsuit)') == 'azusa-swimsuit'
    assert fold('Aris') == fold('Arisu') == 'arisu'
    assert fold('Armed') == fold('Battle') == 'battle'
    assert fold('Pajamas') == fold('Pajama') == 'pajama'
    assert split_name('Azusa (Swimsuit)') == ('Azusa', 'Swimsuit')
    assert split_name('Hina') == ('Hina', '')
    assert name_matches('Azusa (Swimsuit)', 'Azusa (Swimsuit)')
    assert name_matches('Eimi (Armed)', 'Eimi (Battle)')
    assert name_matches('Aris (Maid)', 'Arisu (Maid)')
    # 변형 없는 이름이 변형 일정에, 또는 다른 변형에 붙으면 다른 학생 배너가 붙는다.
    assert not name_matches('Hina', 'Hina (Dress)')
    assert not name_matches('Hina (Dress)', 'Hina (Swimsuit)')
    assert not name_matches('Mika', 'Miyako')
    assert title_students('Azusa (Swimsuit) 외 9명 픽업') == ['Azusa (Swimsuit)']
    assert title_students('Kikyou (Swimsuit), Renge (Swimsuit) 픽업 (복각)') == ['Kikyou (Swimsuit)', 'Renge (Swimsuit)']
    # 배너는 자기 섹션 헤더 바로 뒤 이미지다. 맨 앞 이미지는 게시판 공지 배너라 누구의 것도 아니고,
    # 뒤에 이미지가 없는 섹션은 붙이지 않는다.
    body = ('<img src="notice.png"><p>1) <span>나구사</span>(★3, 수영복) 픽업 모집</p><img src="a.png">'
            '<p>2) [복각] 츠바키(★3) 특별 픽업 모집</p><img src="b.png">'
            '<p>3) 제목만 있고 배너가 없는 픽업 모집</p>')
    assert notice_banners(body) == [('나구사(수영복)', 'a.png'), ('츠바키', 'b.png')]
    # '丽'(레이)는 '爱丽丝'(아리스) 안에 들어 있다. 짧은 이름만 보면 다른 학생 배너가 붙는다.
    zh_names = {'丽', '爱丽丝', '爱丽丝（女仆）'}
    absorbed = {zh: [other for other in zh_names if other != zh and zh in other] for zh in zh_names}
    assert cn_visible('丽', '限时招募：丽', absorbed['丽'])
    assert cn_visible('丽', '限时招募：丽、爱丽丝（女仆）', absorbed['丽'])
    assert not cn_visible('丽', '限时招募：爱丽丝（女仆）', absorbed['丽'])
    # 같은 학생 이름이 있어도 점검·활동 공지 이미지를 픽업 배너로 쓰지 않는다.
    pickups = [{'id': 'misaki', 'category': 'pickup', 'title': 'Misaki 픽업'}]
    names = {'Misaki': {'zh': '美咲'}}
    unrelated = [{'id': 1, 'title': '美咲维护通知', 'banner': 'maintenance.png'},
                 {'id': 2, 'title': '美咲限时活动', 'banner': 'event.png'}]
    assert match_cn(pickups, unrelated, names) == {}
    recruitment = {'id': 3, 'title': '限时招募：美咲', 'banner': 'misaki.png'}
    assert match_cn(pickups, unrelated + [recruitment], names) == {'misaki': ('Misaki', '3', 'misaki.png')}
    # 공식 출처 URL: 포럼 스레드는 og:url, JP/CN은 사이트 라우터 경로(/news/newsJump/:id, /news/:id).
    assert KR_THREAD_URL.format(id='3554399') == ('https://forum.nexon.com/bluearchive/board_view'
                                                 '?board=1018&thread=3554399')
    assert CN_SITE + '/news/1707' == 'https://www.bluearchive-cn.com/news/1707'
    # JP 원제 매칭: 위키와 공식 뉴스가 띄어쓰기·기호·대소문자를 다르게 쓴다.
    assert fold_jp('Dive into OCEAN！') == fold_jp('DIVE into OCEAN!') == 'diveintoocean'
    assert fold_jp('鉄道爆走事件 〜そして列車はなくなった〜') == fold_jp('鉄道爆走事件〜そして列車はなくなった〜')
    assert jp_title({'description': 'Rerun · 夏空のやくそく'}) == '夏空のやくそく'
    assert jp_title({'description': '嵐過天晴'}) == '嵐過天晴'
    assert jp_title({'description': '이벤트 · Joint Firing Drill'}) == 'Joint Firing Drill'
    index = {fold_jp('【イベント】「嵐過天晴」紹介'): '671', fold_jp('【総力戦】ビナー開催'): '900'}
    jp_events = [{'id': 'hit', 'servers': ['jp'], 'description': '嵐過天晴'},
                 {'id': 'section-label', 'servers': ['jp'], 'description': 'Raid list'},
                 {'id': 'gl-track', 'servers': ['gl'], 'description': '嵐過天晴'}]
    # GL 트랙은 JP 공식 뉴스로 가지 않고, 원제가 없는 총력전 행도 붙지 않는다.
    assert match_jp_news(jp_events, index) == {'hit': 'https://bluearchive.jp/news/newsJump/671'}
    print('selftest ok')


def main():
    if '--selftest' in sys.argv:
        selftest()
        return
    report = '--report' in sys.argv
    bundle = json.load(open(EVENTS, encoding='utf-8'))
    events = bundle['events']

    print('SchaleDB 이름표 읽는 중…')
    names = student_names()
    print(f'  학생 {len(names)}명 (kr {sum(1 for v in names.values() if v.get("kr"))} / zh {sum(1 for v in names.values() if v.get("zh"))})')

    # 픽업·이벤트는 한국·글로벌 트랙에만 매칭한다. 레이드의 한국어 아트는 아래에서 별도 연결한다.
    # 같은 픽업이 양쪽에 있어도 서버 트랙과 배너 언어를 섮지 않는다.
    track = [e for e in events if 'gl' in e['servers']]
    for event in events:
        if 'gl' not in event['servers']:
            kept = {k: v for k, v in (event.get('images') or {}).items() if k not in ('kr', 'zh')}
            # 빈 images는 스키마가 거부한다. 남는 게 없으면 필드 자체를 뺀다.
            if kept:
                event['images'] = kept
            else:
                event.pop('images', None)

    print('CN 뉴스 수집 중…')
    zh = match_cn(track, cn_news_rows(), names)
    print(f'  픽업 매칭 {len(zh)}건')

    print('KR 포럼 모집 공지 수집 중…')
    kr = match_kr_forum(track, names)
    print(f'  픽업 매칭 {len(kr)}건')
    print('KR 마이크로사이트 수집 중…')
    kr.update({id_: payload for id_, payload in match_kr_sites(track, kr_microsites()).items()
               if id_ not in kr})
    print(f'  합계 {len(kr)}건')

    # 공식 출처: 매칭이 이미 공식 URL을 들고 있다(포럼 공지 스레드·이벤트 마이크로사이트·CN 뉴스 기사).
    # 같은 일정에 KR과 CN이 다 있으면 한국어 공지를 먼저 쓴다.
    official = {id_: f'{CN_SITE}/news/{payload[1]}' for id_, payload in zh.items()}
    official.update({id_: payload[1] for id_, payload in kr.items()})

    print('JP 공식 뉴스 매칭 중…')
    jp = match_jp_news(events, jp_news_ids())
    print(f'  이벤트 매칭 {len(jp)}건')
    official.update(jp)

    # JP 트랙은 공식 채널이 하나뿐이라 매칭이 없으면 JP 뉴스 목록으로 보낸다. GL 트랙은
    # KR/GL로 채널이 갈리므로, 매칭이 없으면 개별 일정을 실제로 설명하는 위키 URL을 그대로 둔다.
    switched = 0
    for event in events:
        url = official.get(event['id']) or (JP_NEWS_LIST if event['servers'] == ['jp'] else None)
        if url:
            event['source_url'] = url
            switched += 1

    if report:
        for id_, (student, news_id, url) in sorted(zh.items()):
            print(f'    zh  {student:22} cn news {news_id}')
        for id_, payload in sorted(kr.items()):
            print(f'    kr  {payload[0]:22} {next(e["title"] for e in events if e["id"] == id_)[:40]}')
        unmatched = [e['title'] for e in track if e['category'] == 'pickup' and e['id'] not in zh]
        print(f'  zh 미매칭 {len(unmatched)}건:', unmatched[:8])
        missed = sum(1 for e in events if e['servers'] == ['jp'] and e['id'] not in jp)
        print(f'  jp 딥링크 {len(jp)}건 / 미매칭 {missed}건 → {JP_NEWS_LIST}')
        return

    if subprocess.run(['which', 'cwebp'], capture_output=True, check=False).returncode:
        sys.exit('cwebp가 필요합니다 (brew install webp).')

    os.makedirs(BANNER_DIR, exist_ok=True)
    added = {
        'zh': attach(events, zh, 'zh', lambda p: f'zh-cn-{p[1]}-{slug(p[0], 40)}'),
        'kr': attach(events, kr, 'kr', lambda p: f'kr-{slug(p[0], 60)}'),
    }

    # 이번 실행에서 매칭되지 않은 픽업은 그 언어 배너를 지운다. 남겨 두면 지난 실행의 잘못된
    # 매칭(다른 학생 배너)이 그대로 살아남는다. 다운로드만 실패한 일정은 매칭됐으므로 남는다.
    for event in track:
        if event['category'] != 'pickup':
            continue
        for lang, picked in (('zh', zh), ('kr', kr)):
            if event['id'] not in picked and lang in (event.get('images') or {}):
                del event['images'][lang]
                if not event['images']:
                    event.pop('images')

    # 레이드 아트는 서버·일정과 무관하게 데이터셋이 정의한다. 빠진 한국어 아트만 받아 둔다.
    from vendor_raid_banners import ensure_kr_assets
    added['kr_raids'] = ensure_kr_assets()

    bundle['events'] = sorted(events, key=lambda e: (e['start'], e['id']))
    publish_events(EVENTS, bundle)

    # 게시가 성공한 뒤에만 쓰이지 않는 배너를 지운다. 보스 공용 아트는 남긴다.
    referenced = {f for e in events for f in (e.get('images') or {}).values()} | raid_assets()
    stale = [n for n in os.listdir(BANNER_DIR) if n.endswith('.webp') and n not in referenced]
    for name in stale:
        os.remove(os.path.join(BANNER_DIR, name))

    langs = {lang: sum(1 for e in events if lang in e.get('images', {})) for lang in ('jp', 'kr', 'en', 'zh')}
    print(f'연결 {added}, 언어별 보유: {langs}, 정리한 배너 {len(stale)}개')
    print(f'출처: 공식 딥링크 {len(official)}건, JP 뉴스 목록 {switched - len(official)}건, 위키 {len(events) - switched}건')


if __name__ == '__main__':
    main()
