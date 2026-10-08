// 보스별 공용 아트: 같은 보스가 다시 돌면 재사용한다.
// 단, JP 일정에는 jp 배너만 주입한다. KR 미공개 보스의 JP 일정에 KR 배너가 뜨지 않게.
// 서버 미지정·전체 일정과 GL 일정은 전 언어를 주입한다(기존 동작 유지).
export const RAID_BANNERS = {
  binah: {
    names: ['Binah', '비나', 'ビナー'],
    total: { jp: 'raid-total-decagrammaton-binah.webp', kr: 'kr-raid-total-decagrammaton-binah.webp' },
    grand: { jp: 'raid-grand-decagrammaton-binah-grand-assault.webp', kr: 'kr-raid-grand-decagrammaton-binah-grand-assault.webp' },
  },
  gregorius: {
    names: ['Gregorius', '그레고리오', 'グレゴリオ'],
    total: { jp: 'raid-total-communio-sanctorum-gregorius.webp', kr: 'kr-raid-total-communio-sanctorum-gregorius.webp' },
  },
  hieronymus: {
    names: ['Hieronymus', '예로니무스', 'ヒエロニムス'],
    total: { jp: 'raid-total-communio-sanctorum-hieronymus.webp', kr: 'kr-raid-total-communio-sanctorum-hieronymus.webp' },
    grand: { jp: 'raid-grand-communio-sanctorum-hieronymus-grand-assault.webp', kr: 'kr-raid-grand-communio-sanctorum-hieronymus-grand-assault.webp' },
  },
  hod: {
    names: ['Hod', '호드', 'ホド'],
    grand: { jp: 'raid-grand-decagrammaton-hod-grand-assault.webp', kr: 'kr-raid-grand-decagrammaton-hod-grand-assault.webp' },
  },
  goz: {
    names: ['Goz', '고즈', 'ゴズ'],
    total: { jp: 'raid-total-slumpia-goz.webp', kr: 'kr-raid-total-slumpia-goz.webp' },
  },
  perorodzilla: {
    names: ['Perorodzilla', '페로로지라', 'ペロロジラ'],
    total: { jp: 'raid-total-the-library-of-lore-perorodzilla.webp', kr: 'kr-raid-total-the-library-of-lore-perorodzilla.webp' },
    grand: { jp: 'raid-grand-the-library-of-lore-perorodzilla-grand-assault.webp', kr: 'kr-raid-grand-the-library-of-lore-perorodzilla-grand-assault.webp' },
  },
  kaiten: {
    names: ['KAITEN FX Mk.0', '카이텐'],
    total: { jp: 'raid-total-kaitenger-kaiten-fx-mk-0.webp', kr: 'kr-raid-total-kaitenger-kaiten-fx-mk-0.webp' },
  },
  kurokage: {
    names: ['Kurokage', '쿠로카게', 'クロカゲ'],
    grand: { jp: 'raid-grand-one-hundred-ghost-tales-myouki-kurokage-grand-ass.webp', kr: 'kr-raid-grand-one-hundred-ghost-tales-myouki-kurokage-grand-ass.webp' },
  },
  shirokuro: {
    names: ['ShiroKuro', 'Shiro & Kuro', '시로&쿠로', '시로 & 쿠로', '시로쿠로', 'シロ＆クロ'],
    grand: { jp: 'raid-grand-slumpia-shirokuro-grand-assault.webp', kr: 'kr-raid-grand-slumpia-shirokuro-grand-assault.webp' },
  },
  drumbarka: {
    names: ['Drumbarka', '드럼통 게', 'ドラム'],
    total: { jp: 'raid-total-the-library-of-lore-drumbarka.webp', kr: 'kr-raid-total-the-library-of-lore-drumbarka.webp' },
  },
  hovercraft: {
    names: ['Hovercraft', '호버크래프트', 'ホバークラフト'],
    grand: { jp: 'raid-grand-wakamo-hovercraft-grand-assault.webp', kr: 'kr-raid-grand-wakamo-hovercraft-grand-assault.webp' },
  },
  geburah: {
    names: ['Geburah', '게부라', 'ゲブラ'],
    grand: { jp: 'raid-grand-decagrammaton-geburah-grand-assault.webp' },
  },
};

// 데이터셋이 참조하는 모든 파일. 수집 도구와 테스트가 같은 목록을 쓴다(중복 정의 금지).
export const RAID_BANNER_FILES = [...new Set(Object.values(RAID_BANNERS).flatMap(boss => ['total', 'grand'].flatMap(type => Object.values(boss[type] ?? {}))))];

export function raidImages(event) {
  const title = (event?.title ?? '').toLowerCase();
  const type = /대결전|grand assault|大決戦/i.test(title) ? 'grand' : /총력전|total assault|総力戦/i.test(title) ? 'total' : null;
  if (!type) return {};
  const boss = Object.values(RAID_BANNERS).find(boss => boss.names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(title);
  }));
  const images = boss?.[type] ?? {};
  const servers = Array.isArray(event?.servers) ? event.servers : [];
  if (servers.length === 1 && servers[0] === 'jp') {
    return images.jp ? { jp: images.jp } : {};
  }
  return images;
}
