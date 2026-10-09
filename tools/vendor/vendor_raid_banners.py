"""Official KR raid artwork for the boss dataset (compat/calendar-v1/raid-banners.ts).

The dataset is the single source of truth: this tool downloads the `kr-*` files the
dataset lists, keyed by the JP asset stem, and nothing else. Artwork may come from an
earlier season; the schedule itself stays untouched. A dataset entry without a curated
URL (e.g. Geburah) keeps its JP art — no other boss's banner stands in for it.

Run:  python3 tools/vendor/vendor_raid_banners.py
Writes: resource/event_banner_img/kr-raid-*.webp
"""
import sys

from vendor_banners import download
from vendor_events import raid_assets

# JP asset stem (-> kr-<stem>.webp in the dataset): (official thread ID, verified Korean artwork URL).
BANNERS = {
    'raid-total-decagrammaton-binah': (2540259,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20240404/52a0ad63-8092-4077-aac1-87fdeb091ebc/image202404041112464.png'),
    'raid-total-slumpia-goz': (2485226,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20240201/5a39e968-2ff1-46fb-8edf-8b3112c553ef/image202402011424512.png'),
    'raid-total-communio-sanctorum-gregorius': (2455715,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20231228/071325e3-8d3a-4203-b9c0-58fdc755f7f7/image202312281120282.png'),
    'raid-total-kaitenger-kaiten-fx-mk-0': (2746610,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20250313/39d728b7-8340-4af2-935d-a45901c29ae7/BA%EC%B4%9D%EB%A0%A5%EC%A0%84%EC%B9%B4%EC%9D%B4%ED%85%901920x1080KR%EA%B0%9C%EC%B5%9C%EC%98%88%EC%A0%95.jpg'),
    'raid-total-communio-sanctorum-hieronymus': (2875000,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20250516/6f76fcdb-532d-4732-8acc-48ee47cdf1d8/%EC%98%88%EB%A1%9C%EB%8B%88%EB%AC%B4%EC%8A%A4%EC%8B%9C%EA%B0%80%EC%A0%84.png'),
    'raid-total-the-library-of-lore-perorodzilla': (2719177,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20250122/3df7ae21-e3e8-4a53-a42d-7a1bfe1134b7/image.png'),
    'raid-grand-decagrammaton-hod-grand-assault': (2569879,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20240520/86eae5bf-bdf3-4365-9a15-abd2436f33ac/image202405201100297.png'),
    'raid-grand-one-hundred-ghost-tales-myouki-kurokage-grand-ass': (2796906,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20250407/9adef37f-7dda-455a-a8d4-6b246f0fe614/BA%EB%8C%80%EA%B2%B0%EC%A0%84%EC%BF%A0%EB%A1%9C%EC%B9%B4%EA%B2%8C%EC%8B%9C%EA%B0%80%EC%A0%84%ED%8A%B8%EC%9C%84%ED%84%B0B1920x1080KR01%EC%98%88%EC%A0%95.png'),
    'raid-grand-the-library-of-lore-perorodzilla-grand-assault': (2742131,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20250306/82947f2e-d31e-4dad-bd50-1ccb184d27f2/BA%EB%8C%80%EA%B2%B0%EC%A0%84%ED%8E%98%EB%A1%9C%EB%A1%9C%EC%A7%80%EB%9D%BC%EC%95%BC%EC%A0%84%EA%B0%9C%EC%B5%9CKR%ED%8A%B8%EC%9C%84%ED%84%B01280x720.jpg'),
    'raid-grand-wakamo-hovercraft-grand-assault': (2693563,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20241203/846d3152-f07c-4f84-9679-0390b131aaff/BA%EC%B4%9D%EB%A0%A5%EC%A0%84%ED%98%B8%EB%B2%84%ED%81%AC%EB%9E%98%ED%94%84%ED%8A%B8%EC%95%BC%EC%A0%84%ED%8A%B8%EC%9C%84%ED%84%B01280x720%EA%B0%9C%EC%B5%9C%EC%98%88%EC%A0%95.jpg'),
    'raid-grand-decagrammaton-binah-grand-assault': (2637013,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20240906/d39dc164-6c34-4ee2-b040-2105a9db3612/image202409061129272.png'),
    'raid-grand-slumpia-shirokuro-grand-assault': (2597613,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20240705/c3a8fb48-fd0f-43da-ac2e-68b060642691/image2024070517335883.png'),
    'raid-grand-communio-sanctorum-hieronymus-grand-assault': (2674288,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20241104/a78aba05-a635-4fbe-80f7-6d7c0f373cf5/image2024110411430116.png'),
    'raid-total-the-library-of-lore-drumbarka': (3536012,
        'https://dszw1qtcnsa5e.cloudfront.net/community/20260914/cbc0aee5-de08-473c-9f59-9e4809d21042/%EC%B4%9D%EB%A0%A5%EC%A0%84%EB%93%9C%EB%9F%BC%ED%86%B5%EA%B2%8C.png'),
}


def ensure_kr_assets():
    """Download every `kr-*` file the dataset lists; returns how many landed."""
    wanted = {name: name[len('kr-'):-len('.webp')] for name in sorted(raid_assets()) if name.startswith('kr-')}
    if not wanted:
        sys.exit('compat/calendar-v1/raid-banners.ts에서 한국어 아트 목록을 읽지 못했습니다.')
    undocumented = [stem for stem in wanted.values() if stem not in BANNERS]
    if undocumented:
        sys.exit(f'데이터셋에 있으나 공식 원본이 등록되지 않은 한국어 아트: {", ".join(undocumented)}')
    for stem in BANNERS.keys() - set(wanted.values()):
        print(f'  참고: 데이터셋에 없는 수집 항목 {stem} — 데이터셋에서 지웠다면 이 줄도 지우세요.')
    added = 0
    for name, stem in wanted.items():
        file = download(BANNERS[stem][1], name[:-len('.webp')])
        if file != name:
            sys.exit(f'파일명이 데이터셋과 다릅니다: {file} != {name}')
        added += 1
    return added


if __name__ == '__main__':
    print(f'한국어 총력전·대결전 배너 확인: {ensure_kr_assets()}건')
