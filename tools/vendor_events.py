"""Vendoring of the real Blue Archive operation schedule (fan-project data prep, not app runtime).

Source: bluearchive.wiki (MediaWiki API, action=parse). JP is the lead schedule
(`servers: ["jp"]`); KR follows the delayed global track, so Global pages cover
both (`servers: ["gl"]`).

  Events          : Events Schedule (JP + GL periods), Mini-Event (JP key art),
                    Joint Firing Drill (JP venue art), Reward campaigns (JP official
                    maintenance art matched by multiplier + date),
                    Attendance bonuses (JP, no dedicated art yet), Guide missions (JP)
  Total Assault   : Raid list, first table JP, second table GL
  Grand Assault   : Grand Assault list, first table JP, second table GL
  Banner List     : rate-up recruitment periods (JP) + lobby banner art
  Banner List (Global): rate-up recruitment periods (GL) + lobby banner art

The event key art and recruitment banners the wiki shows are vendored into
resource/event_banner_img/ as webp (needs curl and cwebp), as are the exact boss
banners (`Raid Banner …` / `EliminateRaid Banner …`), the drill venue screenshot,
mini-event key art, and the official JP maintenance banners for drop/EXP campaigns.
Events whose art no source has keep an empty images field and the app falls back
to the generic banners. Art is labelled by the language of its source page
(JP pages -> jp, Banner List (Global) -> en); the app prefers the reader's
language and falls back to jp.

Titles are the real English names the wiki publishes, with a Korean category tag
where the calendar needs one to stay scannable. Nothing here is invented: a row the
wiki has no date for (TBD) is skipped rather than guessed.

Run:  python3 tools/vendor_events.py
Writes: resource/events.json, resource/event_banner_img/*.webp
        (window today-90d .. today+270d)
"""

import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public/resource', 'events.json')
BANNER_DIR = os.path.join(ROOT, 'public/resource', 'event_banner_img')
API = 'https://bluearchive.wiki/w/api.php'
UA = 'molu-calendar-vendoring (one-off fan project data build)'
PAST_DAYS, FUTURE_DAYS = 90, 270
BANNER_WIDTH, WEBP_QUALITY = 640, '82'   # 640px covers the sidebar and the detail dialog
KST = timezone(timedelta(hours=9))
# The wiki fills open-ended periods with a far-future placeholder (2099/2125) instead of
# leaving the end blank. Read as "no announced end" rather than as a real date.
SENTINEL_YEAR = 2090


def publish_events(path, bundle):
    """Replace the published bundle only after a complete sibling file is closed."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                         dir=os.path.dirname(os.path.abspath(path)),
                                         prefix='.events-', suffix='.tmp', delete=False) as handle:
            temporary = handle.name
            json.dump(bundle, handle, ensure_ascii=False, indent=1)
            handle.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.remove(temporary)


def page(name):
    url = f'{API}?action=parse&page={name}&prop=text&format=json&formatversion=2'
    result = subprocess.run(['curl', '-sL', '--max-time', '60', '-A', UA, url],
                            capture_output=True, text=True, check=False)
    try:
        return json.loads(result.stdout)['parse']['text']
    except (ValueError, KeyError):
        sys.exit(f'failed to load {name}')


def text(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', re.sub(r'<style.*?</style>', '', value, flags=re.S)))).strip()


def instant(value):
    """data-datetime attribute -> schema instant (+09 / +0900 / Z all normalized)."""
    match = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}(?::?\d{2})?)$', value)
    if not match:
        return None
    stamp, zone = match.groups()
    if len(stamp) == 16:
        stamp += ':00'
    if zone == 'Z':
        return stamp + '+00:00'
    digits = zone[1:].replace(':', '')
    return f'{stamp}{zone[0]}{digits[:2]}:{digits[2:4] or "00"}'


def instants(cell):
    return [value for value in (instant(v) for v in re.findall(r'data-datetime="([^"]+)"', cell)) if value]


def closing(stamps):
    """First announced end instant, or None when the cell is empty or holds the placeholder."""
    return stamps[0] if stamps and int(stamps[0][:4]) < SENTINEL_YEAR else None


def range_end(stamps):
    """End of a start-cell date range (second instant)."""
    return closing(stamps[1:])


def link(cell):
    match = re.search(r'href="(/wiki/[^"]+)"', cell)
    return 'https://bluearchive.wiki' + html.unescape(match.group(1)) if match else None


def wiki_url(name):
    return 'https://bluearchive.wiki/wiki/' + name.replace(' ', '_')


# source file name -> local file name, so a rerun shares its release banner.
IMAGES = {}
# wiki File: name -> (original url, width), so exact art resolves once.
FILE_URLS = {}
# wiki detail page url -> (hero image url, width), for linked key art.
DETAIL_PAGES = {}
# Joint Firing Drill has no per-mode art; every drill shares the venue screenshot.
DRILL_FILE = 'Replay Contents TimeAttack EpisodeSelect.png'
JP_NEWS_API = 'https://api-web.bluearchive.jp/api/news'


def download(url, path):
    subprocess.run(['curl', '-sL', '--max-time', '60', '-A', UA, '-o', path, url], check=True)
    magic = open(path, 'rb').read(4) if os.path.exists(path) else b''
    if magic not in (b'\x89PNG', b'\xff\xd8\xff\xe0', b'\xff\xd8\xff\xe1'):
        sys.exit(f'not an image (wiki error page?): {url}')


def image_file(url, width, name=None):
    """Fetch one banner image as webp at <=640px wide; returns its local file name."""
    if not url:
        return None
    if url in IMAGES:
        return IMAGES[url]
    if name:
        local = slug(name)[:60]
    else:
        source = re.sub(r'^\d+px-', '', urllib.parse.unquote(url.rsplit('/', 1)[-1]))
        local = slug(re.sub(r'\.(?:png|jpe?g|webp)$', '', source, flags=re.I))[:60]
    while f'{local}.webp' in IMAGES.values():
        local += '-2'
    IMAGES[url] = f'{local}.webp'
    target = os.path.join(BANNER_DIR, f'{local}.webp')
    if not os.path.exists(target):
        # MediaWiki renders a thumb at any width up to the original; smaller originals come as-is.
        # Direct originals wider than the banner target get a thumb URL built the same way.
        if width > BANNER_WIDTH and '/thumb/' not in url:
            base, leaf = url.rsplit('/', 1)
            fetch = base.replace('/bluearchivewiki/', '/bluearchivewiki/thumb/', 1) + f'/{leaf}/{BANNER_WIDTH}px-{leaf}'
        else:
            # Thumb URLs upscale to the banner width; small originals come as-is.
            if '/thumb/' not in url:
                fetch = url
            elif 0 < width <= BANNER_WIDTH:
                fetch = re.sub(r'/thumb/', '/', url.rsplit('/', 1)[0])
            else:
                fetch = re.sub(r'/\d+px-', f'/{BANNER_WIDTH}px-', url)
        raw = os.path.join(BANNER_DIR, f'.{local}.png')
        download(fetch, raw)
        subprocess.run(['cwebp', '-q', WEBP_QUALITY, '-quiet', raw, '-o', target], check=True)
        os.remove(raw)
    return IMAGES[url]


def wiki_file(name):
    """Original URL + width for a wiki File, cached; (None, 0) when missing."""
    if name not in FILE_URLS:
        result = subprocess.run(['curl', '-sL', '--max-time', '60', '-A', UA,
            f'{API}?action=query&prop=imageinfo&iiprop=url|size&format=json&formatversion=2&titles=' + urllib.parse.quote(f'File:{name}')],
            capture_output=True, text=True, check=False)
        try:
            pages = json.loads(result.stdout)['query']['pages']
            pages = pages.values() if isinstance(pages, dict) else pages
            info = next(iter(pages), {}).get('imageinfo')
        except (ValueError, KeyError, StopIteration, AttributeError):
            info = None
        FILE_URLS[name] = (info[0]['url'], info[0]['width']) if info else (None, 0)
    return FILE_URLS[name]


def detail_hero(page_url):
    """First large non-icon image on a linked wiki detail page."""
    if not page_url or '/wiki/' not in page_url:
        return None, 0
    if page_url not in DETAIL_PAGES:
        name = urllib.parse.unquote(page_url.rsplit('/wiki/', 1)[-1])
        doc = page(name)
        found = (None, 0)
        fallback = (None, 0)
        for match in re.finditer(r'<img[^>]*src="([^"]+)"[^>]*>', doc):
            tag = match.group(0)
            if 'Item_Icon' in tag or 'Collectible_Icon' in tag:
                continue
            full = re.search(r'data-file-width="(\d+)"', tag)
            width = int(full.group(1)) if full else 0
            src = match.group(1)
            url = 'https:' + src if src.startswith('//') else src
            if not fallback[0]:
                fallback = (url, width)
            if width >= 500:
                found = (url, width)
                break
        DETAIL_PAGES[page_url] = found if found[0] else fallback
    return DETAIL_PAGES[page_url]


# Exact boss banner files. Total Assault uses `Raid Banner …`; Grand Assault uses
# `EliminateRaid Banner …` (Grand Geburah only has the plain Raid file).
RAID_BOSS_FILES = {
    'binah': 'Binah', 'gregorius': 'Gregorius', 'hieronymus': 'Hieronymus',
    'hod': 'Hod', 'goz': 'Goz', 'perorodzilla': 'Perorodzilla',
    'kaitenger': 'Kaitenger', 'kurokage': 'Kurokage', 'shirokuro': 'ShiroKuro',
    'drumbarka': 'Drumbarka', 'hovercraft': 'Hovercraft', 'geburah': 'Geburah',
    'chesed': 'Chesed', 'yesod': 'Yesod',
}
RAID_BOSS_ALIASES = {'kaiten fx mk.0': 'kaitenger', 'myouki kurokage': 'kurokage'}


def raid_filename(title, grand):
    """Exact wiki banner file for a raid title, or None when the boss is unknown."""
    raw = title.split(':', 1)[1] if ':' in title else title
    raw = re.sub(r'\s*\(Grand Assault\)\s*$', '', raw).strip().lower()
    key = RAID_BOSS_ALIASES.get(raw, raw)
    base = RAID_BOSS_FILES.get(key)
    if not base:
        return None
    if key == 'hod' and not grand:
        base = 'HOD'
    if grand and key == 'geburah':
        return 'Raid Banner Geburah.png'
    return f"{'EliminateRaid' if grand else 'Raid'} Banner {base}.png"


def raid_assets():
    """보스 공용 아트(raid-banners.js) 파일명. 일정 창과 무관하게 보존해야 하는 목록이다.

    목록을 여기에 복사하지 않고 데이터셋에서 읽는다 — 두 곳에 적으면 한쪽만 고쳐져
    로테이션에서 빠진 보스의 아트가 조용히 삭제된다.
    """
    path = os.path.join(ROOT, 'raid-banners.js')
    if not os.path.exists(path):
        return set()
    with open(path, encoding='utf-8') as handle:
        return set(re.findall(r"'([A-Za-z0-9_-]+\.webp)'", handle.read()))


def jp_news(path):
    """Parsed JSON from the official JP site API; {} when the call fails."""
    result = subprocess.run(['curl', '-sL', '--max-time', '60', '-A', UA, JP_NEWS_API + path],
                            capture_output=True, text=True, check=False)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {}


def jp_campaign_notices(today):
    """(kind, publish date, banner url) from recent JP maintenance notices.

    kind is one of triple / double / exp. Only notices near the vendoring window
    are read, so a rerun stays cheap.
    """
    try:
        rows = jp_news('/list?typeId=3&pageNum=100&pageIndex=1')['data']['rows']
    except (KeyError, TypeError):
        return []
    cutoff = today - timedelta(days=PAST_DAYS + 60)
    notices = []
    for row in rows:
        pub = datetime.fromtimestamp(row['publishTime'] / 1000, tz=KST).date()
        if pub < cutoff:
            continue
        try:
            doc = jp_news(f"/detail?id={row['id']}")['data']['news']['content']
        except (KeyError, TypeError):
            continue
        parts = re.split(r'(<img[^>]+>)', doc)
        for i, part in enumerate(parts):
            if not part.startswith('<img'):
                continue
            before = text(parts[i - 1]) if i else ''
            src = re.search(r'src="([^"]+)"', part)
            if not src:
                continue
            if '報酬ドロップ量3倍' in before:
                kind = 'triple'
            elif '報酬ドロップ量2倍' in before:
                kind = 'double'
            elif '先生レベル経験値2倍' in before:
                kind = 'exp'
            else:
                continue
            notices.append((kind, pub, src.group(1)))
    return notices


def campaign_kind(title):
    if title.startswith('Triple'):
        return 'triple'
    if title.startswith('Double level EXP'):
        return 'exp'
    if title.startswith('Double'):
        return 'double'
    return None


def official_campaign_image(kind, start, notices):
    """Official JP banner for a campaign row: the latest notice published before it.

    A notice published after the campaign started cannot be the one that announced it:
    the 08-25 maintenance lists 08-29~31 and 09-05~07, so taking the latest publication
    in the window hands the 08-22 campaign artwork for dates it never covered.
    """
    if not kind:
        return None, 0, None
    day = kst_day(start)
    cands = [(pub, url) for key, pub, url in notices if key == kind
             and day - timedelta(days=28) <= pub <= day]
    if not cands:
        return None, 0, None
    pub, url = max(cands)
    names = {'triple': 'drop-3x', 'double': 'drop-2x', 'exp': 'exp-2x'}
    return url, 0, f"campaign-{names[kind]}-{pub:%Y%m%d}"


def banner_from(cell):
    """Image in a wiki cell as (url, full width)."""
    match = re.search(r'<img[^>]*src="([^"]+)"[^>]*>', cell)
    if not match:
        return None, 0
    url = 'https:' + match.group(1) if match.group(1).startswith('//') else match.group(1)
    full = re.search(r'data-file-width="(\d+)"', match.group(0))
    return url, int(full.group(1)) if full else 0


def rows_of(doc, heading, index=0):
    """(row html, cells) for the index-th table under a heading, header rows removed.

    An empty heading means "the first table on the page" (Banner List has no headings).
    """
    heads = [(m.start(), text(m.group(2))) for m in re.finditer(r'<h([123])[^>]*>(.*?)</h\1>', doc, re.S)]
    seen = 0
    for table in re.finditer(r'<table.*?</table>', doc, re.S):
        head = next((h[1] for h in reversed(heads) if h[0] < table.start()), '')
        if heading and head != heading:
            continue
        if seen < index:
            seen += 1
            continue
        rows = [(row, re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.S))
                for row in re.findall(r'<tr[^>]*>(.*?)</tr>', table.group(0), re.S)]
        return [row for row in rows if '<td' in row[0]]
    return []


def kst_day(stamp):
    return datetime.fromisoformat(stamp).astimezone(KST).date()


def slug(value):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', value.lower())).strip('-')[:70] or 'event'


def make(kind, title, category, start, end, description, source_url, today, servers, image=None, lang='jp'):
    """One schema-v1 event, dropped when its period falls outside the vendoring window.

    image is called only for events that survive the window, so out-of-window rows
    never trigger a download. `servers` lists the servers this period applies to;
    JP records get a -jp id suffix and GL records a -gl id suffix. `lang` names the
    language of the art's source page (the app falls back to jp when it is missing).
    """
    if kst_day(start) > today + timedelta(days=FUTURE_DAYS):
        return None
    if (kst_day(end) if end else kst_day(start)) < today - timedelta(days=PAST_DAYS):
        return None
    banner = image() if image else None
    suffix = '-jp' if list(servers) == ['jp'] else '-gl' if list(servers) == ['gl'] else ''
    return {
        'id': f'wiki-{kind}-{kst_day(start):%Y%m%d}-{slug(title)}{suffix}',
        'title': title[:160],
        'category': category,
        'all_day': False,
        'start': start,
        'end': end,
        'status': 'confirmed',
        'description': description,
        'source_url': source_url,
        'servers': list(servers),
        **({'images': {lang: banner}} if banner else {}),
    }


def simple_rows(doc, heading, category, label, today, source, servers, index=0, art=None):
    """[name, start, end, (season)] tables: mini events, campaigns, bonuses, drills.

    art maps (title, link, start, end) to (url, width, local name); it runs only
    for rows that survive the date window, inside make().
    """
    out = []
    for _, cells in rows_of(doc, heading, index):
        if len(cells) < 3:
            continue
        stamps = instants(cells[1])
        if not stamps:
            continue
        title = text(cells[0])
        note = text(cells[3]) if len(cells) > 3 else ''
        row_link = link(cells[0])
        href = row_link or source
        end = closing(instants(cells[2]))
        event = make(slug(heading), f'{title}{label}', category, stamps[0], end,
                     ' · '.join(p for p in (text(heading), note) if p), href, today, servers,
                     (lambda t=title, u=row_link, s=stamps[0], e=end: image_file(*art(t, u, s, e))) if art else None)
        if event:
            out.append(event)
    return out


def event_rows(doc, today):
    """Events Schedule: one record per announced JP / GL period."""
    out = []
    for row, cells in rows_of(doc, 'Events Schedule'):
        if len(cells) < 4:
            continue
        found = re.search(r'data-sort-value="([^"]*)"', row)
        title = html.unescape(found.group(1)) if found else text(cells[1])
        tags = [html.unescape(t) for t in re.findall(r'class="event-tag[^"]*">([^<]+)<', cells[0])]
        original = re.search(r'event-name-original[^"]*"[^>]*>(.*?)</div>', cells[1], re.S)
        notes = text(cells[4]) if len(cells) > 4 else ''
        rerun = ' (복각)' if any('rerun' in tag.lower() for tag in tags) else ''
        description = ' · '.join(p for p in (tags[0] if tags else '', notes, text(original.group(1)) if original else '') if p)
        for period, servers in ((cells[2], ['jp']), (cells[3], ['gl'])):
            stamps = instants(period)
            if not stamps:
                continue   # TBD on the wiki — never guess a date
            event = make('event', f'{title}{rerun}', 'event', stamps[0], range_end(stamps),
                         description, link(cells[1]) or wiki_url('Events'), today, servers,
                         lambda: image_file(*banner_from(cells[0])))
            if event:
                out.append(event)
    return out


def raid_rows(doc, heading, category, label, period_index, season_index, today, source, servers, index=0):
    """Total Assault / Grand Assault: raid name, period, season number. Table index
    selects the JP (0) or GL (1) copy. Each raid gets its exact boss banner."""
    grand = (label == '대결전')
    out = []
    for _, cells in rows_of(doc, heading, index):
        if len(cells) <= max(period_index, season_index):
            continue
        stamps = instants(cells[period_index])
        if not stamps:
            continue
        name = text(cells[0])
        season = text(cells[season_index])
        suffix = f' (시즌 {season})' if season.isdigit() and season != '0' else ''
        notes = text(cells[season_index + 1]) if len(cells) > season_index + 1 else ''
        filename = raid_filename(name, grand)
        event = make(slug(heading), f'{name} {label}{suffix}', category,
                     stamps[0], range_end(stamps),
                     ' · '.join(p for p in (text(heading), notes) if p), link(cells[0]) or source, today, servers,
                     (lambda fn=filename, b=name, g=grand: image_file(*wiki_file(fn), name=f"raid-{'grand' if g else 'total'}-{slug(b)}") if fn else None))
        if event:
            out.append(event)
    return out


def campaign_rows(doc, today, source, servers, notices):
    """Reward campaigns with official JP maintenance art matched by multiplier + date."""
    out = []
    for _, cells in rows_of(doc, 'Reward campaigns'):
        if len(cells) < 3:
            continue
        stamps = instants(cells[1])
        if not stamps:
            continue
        title = text(cells[0])
        kind = campaign_kind(title)
        end = closing(instants(cells[2]))
        href = link(cells[0]) or source
        event = make('reward-campaigns', title, 'campaign', stamps[0], end,
                     'Reward campaigns', href, today, servers,
                     (lambda k=kind, s=stamps[0]: image_file(*official_campaign_image(k, s, notices))) if kind else None)
        if event:
            out.append(event)
    return out


def banner_title(names):
    return f'{names[0]} 외 {len(names) - 1}명' if len(names) > 3 else ', '.join(names)


def banner_rows(doc, today, servers, source, lang='jp'):
    """Rate-up recruitment periods. `source` is (label, url): Banner List or Banner List (Global)."""
    label, url = source
    out = []
    for _, cells in rows_of(doc, ''):
        if len(cells) < 3:
            continue
        stamps = instants(cells[2])
        if not stamps:
            continue
        # Students are links; the plain text around them holds tags and event notes.
        names = [html.unescape(name).strip() for name in re.findall(r'<a[^>]*>([^<]+)</a>', cells[1])]
        full = text(cells[1])
        rerun = ' (복각)' if re.search(r'\brerun\b', full, re.I) else ''
        title = banner_title(names) if names else full
        event = make('pickup', f'{title} 픽업{rerun}', 'pickup', stamps[0], range_end(stamps),
                     f'{label} · ' + full, link(cells[1]) or url, today, servers,
                     lambda: image_file(*banner_from(cells[0])), lang=lang)
        if event:
            out.append(event)
    return out


def main():
    if not subprocess.run(['which', 'cwebp'], capture_output=True, check=False).returncode == 0:
        sys.exit('cwebp가 필요합니다 (brew install webp). 배너 이미지를 webp로 줄여 저장합니다.')
    os.makedirs(BANNER_DIR, exist_ok=True)
    today = date.today()
    events = []
    events += event_rows(page('Events'), today)
    events += simple_rows(page('Events'), 'Mini-Event', 'event', '', today, wiki_url('Events'), ['jp'],
                           art=lambda t, u, s, e: (*detail_hero(u), 'mini-' + slug(t)))
    events += simple_rows(page('Events'), 'Joint Firing Drill', 'event', ' 종합전술시험', today, wiki_url('Events'), ['jp'],
                           art=lambda t, u, s, e: (*wiki_file(DRILL_FILE), 'drill-joint-firing'))
    notices = jp_campaign_notices(today)
    events += campaign_rows(page('Events'), today, wiki_url('Events'), ['jp'], notices)
    events += simple_rows(page('Events'), 'Attendance bonuses', 'campaign', ' 출석 보너스', today, wiki_url('Events'), ['jp'])
    events += simple_rows(page('Events'), 'Guide missions', 'campaign', '', today, wiki_url('Events'), ['jp'])
    events += raid_rows(page('Total_Assault'), 'Raid list', 'event', '총력전', 2, 3, today, wiki_url('Total_Assault'), ['jp'])
    events += raid_rows(page('Total_Assault'), 'Raid list', 'event', '총력전', 2, 3, today, wiki_url('Total_Assault'), ['gl'], index=1)
    events += raid_rows(page('Grand_Assault'), 'Grand Assault list', 'event', '대결전', 3, 4, today, wiki_url('Grand_Assault'), ['jp'])
    events += raid_rows(page('Grand_Assault'), 'Grand Assault list', 'event', '대결전', 3, 4, today, wiki_url('Grand_Assault'), ['gl'], index=1)
    events += banner_rows(page('Banner_List'), today, ['jp'], ('Banner List', wiki_url('Banner_List')))
    events += banner_rows(page('Banner_List_(Global)'), today, ['gl'], ('Banner List (Global)', wiki_url('Banner_List_(Global)')), lang='en')

    # Same title and day twice (e.g. a campaign listed per resource) still needs distinct ids.
    seen, unique = {}, []
    for event in sorted(events, key=lambda e: (e['start'], e['title'])):
        seen[event['id']] = seen.get(event['id'], 0) + 1
        if seen[event['id']] > 1:
            event['id'] += f'-{seen[event["id"]]}'
        unique.append(event)

    publish_events(OUT, {'schema_version': 1, 'events': unique})
    # 이 도구가 만든 배너만 정리한다(창 밖으로 나간 일정의 webp). 보스 공용 아트와 손으로 넣은 jpg는 건드리지 않는다.
    protected = raid_assets()
    stale = [name for name in os.listdir(BANNER_DIR)
             if name.endswith('.webp') and name not in set(IMAGES.values()) and name not in protected]
    for name in stale:
        os.remove(os.path.join(BANNER_DIR, name))
    counts = {key: sum(1 for e in unique if e['category'] == key) for key in ('maintenance', 'pickup', 'event', 'campaign')}
    servers = {key: sum(1 for e in unique if key in e['servers']) for key in ('jp', 'gl')}
    print(f'wrote {len(unique)} events {counts} servers {servers}')
    print(f'banners {len(IMAGES)} (+{len(stale)} stale removed), window {today - timedelta(days=PAST_DAYS)} .. {today + timedelta(days=FUTURE_DAYS)}')


if __name__ == '__main__':
    main()
