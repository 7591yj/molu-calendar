import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { eventsFromDrafts, mergeArchive, buildFeed } from "./build.ts";
import { noticeBlocks } from "./html.ts";
import { toPost } from "./nexon.ts";
import type { Thread } from "./nexon.ts";
import { cleanTitle, noticeTitle, parsePost, splitStudents } from "./parse.ts";
import type { BoardId, Draft } from "./parse.ts";

const fixture = (name: string) => {
  const thread = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Thread;
  return toPost(Number(thread.boardId) as BoardId, thread);
};
const NOW = "2026-10-06T00:00:00.000Z";
const find = (drafts: Draft[], title: RegExp) => {
  const found = drafts.find((draft) => title.test(draft.title));
  if (!found)
    throw new Error(
      `No draft matches ${title}: ${drafts.map((d) => d.title).join(" | ")}`,
    );
  return found;
};

describe("HTML blocks", () => {
  test("expands rowspans so shared dates reach every row", () => {
    const blocks = noticeBlocks(`<table>
      <tr><td>일시</td><td>구분</td><td>내용</td></tr>
      <tr><td rowspan="2"><p>10월 6일(화) 오전 11시</p><p>~ 10월 13일(화) 오전 10시 59분</p></td><td>특별 픽업 모집</td><td>카즈사(밴드)</td></tr>
      <tr><td>픽업 모집</td><td>나츠(밴드)</td></tr></table>`);
    expect(blocks).toEqual([
      {
        type: "table",
        rows: [
          ["일시", "구분", "내용"],
          [
            "10월 6일(화) 오전 11시\n~ 10월 13일(화) 오전 10시 59분",
            "특별 픽업 모집",
            "카즈사(밴드)",
          ],
          [
            "10월 6일(화) 오전 11시\n~ 10월 13일(화) 오전 10시 59분",
            "픽업 모집",
            "나츠(밴드)",
          ],
        ],
      },
    ]);
  });

  test("drops struck-out text so superseded times are never read", () => {
    const blocks = noticeBlocks(
      "<p>1. 일시: 8월 18일(화) 오전 11시 ~ <s>오후 6시</s> 오후 7시</p>",
    );
    expect(blocks).toEqual([
      { type: "line", text: "1. 일시: 8월 18일(화) 오전 11시 ~ 오후 7시" },
    ]);
  });
});

describe("titles and names", () => {
  test("notice titles lose status prefixes, emoji and filler endings", () => {
    expect(cleanTitle("(완료) 9/29(화) 업데이트 상세 안내")).toBe(
      "9/29(화) 업데이트 상세 안내",
    );
    expect(
      noticeTitle(
        "🚨[소멸 임박] 에리카 합류 기념 특별 쿠폰 유효 기간 안내 (~10/9 23:59)",
      ),
    ).toBe("에리카 합류 기념 특별 쿠폰 유효 기간");
    expect(
      noticeTitle(
        "블루 아카이브 ‘5주년 페스티벌’ 2차 창작 부스 참가자 신청 마감 임박!",
      ),
    ).toBe("5주년 페스티벌 2차 창작 부스 참가자 신청");
    expect(noticeTitle("블루 아카이브 X GS25 제휴 이벤트 사전 안내")).toBe(
      "블루 아카이브 X GS25 제휴 이벤트 사전",
    );
  });

  test("student lists split on commas and ampersands but not inside costumes", () => {
    expect(
      splitStudents(
        "나구사(수영복),\n키쿄(수영복) & 렌게(수영복),\n유카리(수영복)",
      ),
    ).toEqual([
      "나구사(수영복)",
      "키쿄(수영복)",
      "렌게(수영복)",
      "유카리(수영복)",
    ]);
    expect(splitStudents("[복각] 키쿄(★3, 수영복) & 렌게(★2, 수영복)")).toEqual(
      ["키쿄(수영복)", "렌게(수영복)"],
    );
  });
});

describe("update detail posts", () => {
  const drafts = parsePost(fixture("update-0929"));

  test("reads the maintenance window, its reward and claim period", () => {
    const maintenance = find(drafts, /정기점검/);
    expect(maintenance).toMatchObject({
      category: "maintenance",
      start: "2026-09-29T11:00:00+09:00",
      end: "2026-09-29T14:00:00+09:00",
    });
    expect(maintenance.notes).toContain("점검 보상: 청휘석 360개");
    expect(maintenance.periods[0]).toMatchObject({
      label: "점검 보상 수령 기간",
      end: "2026-10-06T23:59:00+09:00",
    });
  });

  test("turns every overview row into an event with the right category and kind", () => {
    expect(
      drafts.map((draft) => [draft.category, draft.kind, draft.title]),
    ).toEqual(
      expect.arrayContaining([
        [
          "pickup",
          "interval",
          "나구사(수영복), 키쿄(수영복), 렌게(수영복), 유카리(수영복) 픽업",
        ],
        ["event", "interval", "백에서 피어난 한송이 ~정정당당하게, 수상 승부~"],
        ["raid", "interval", "종합전술시험 사격 시험"],
        ["pickup", "interval", "카즈사(밴드), 요시미(밴드) 특별 픽업"],
        ["pickup", "interval", "나츠(밴드) 픽업"],
        ["event", "release", "-ive aLIVE! 상설화"],
        ["raid", "interval", "대결전 호버크래프트(야전)"],
      ]),
    );
  });

  test('keeps "점검 후" as a flag instead of inventing a clock', () => {
    const story = find(drafts, /백에서 피어난/);
    expect(story.start_after_maintenance).toBe(true);
    expect(story.tags).toEqual(["복각"]);
    expect(story.end).toBe("2026-10-13T10:59:00+09:00");
  });

  test("rowspans give the second pickup row the shared period and note", () => {
    const natsu = find(drafts, /나츠/);
    expect(natsu).toMatchObject({
      start: "2026-10-06T11:00:00+09:00",
      end: "2026-10-13T10:59:00+09:00",
      label: "픽업 모집",
    });
    expect(natsu.notes).toEqual(["10월 13일(화) 오전 11시 모집 포인트 초기화"]);
  });

  test("attaches key art and secondary periods from the detailed sections", () => {
    const story = find(drafts, /백에서 피어난/);
    expect(decodeURIComponent(story.images[0]!)).toMatch(
      /백에서피어난한송이정정당당하게수상승부복각\.png$/,
    );
    expect(story.periods).toEqual([
      expect.objectContaining({
        label: expect.stringMatching(/교환 기간$/),
        end: "2026-10-20T10:59:00+09:00",
      }),
    ]);
    const raid = find(drafts, /호버크래프트/);
    expect(raid.periods).toEqual([
      expect.objectContaining({
        label: "보상 수령 기간",
        end: "2026-11-03T10:59:00+09:00",
      }),
    ]);
    expect(raid.notes.join()).toMatch(/10회 모집 티켓 사용 기한: 11\/30 23:59/);
  });

  test("matches recruitment banners to students by file name, not intro art", () => {
    const pickup = find(drafts, /나구사/);
    const names = pickup.images.map((url) =>
      decodeURIComponent(url.split("/").pop()!),
    );
    expect(names).toEqual([
      "나구사수영복모집.png",
      "복각키쿄수영복렌게수영복모집.png",
      "복각유카리수영복모집.png",
    ]);
  });

  test("splits combined campaign rows", () => {
    expect(
      drafts
        .filter((draft) => draft.category === "campaign")
        .map((draft) => draft.title),
    ).toEqual([
      "스케쥴 2배",
      "학원교류회 2배",
      "임무(Normal) 2배",
      "임무(Hard) 2배",
    ]);
  });
});

describe("other update posts", () => {
  test("8/18: four story releases share a rowspan; extended maintenance uses the corrected end", () => {
    const drafts = parsePost(fixture("update-0818"));
    expect(find(drafts, /정기점검/).end).toBe("2026-08-18T19:00:00+09:00");
    const stories = drafts.filter((draft) => draft.category === "story");
    expect(stories).toHaveLength(4);
    expect(
      stories.every(
        (story) => story.kind === "release" && story.start_after_maintenance,
      ),
    ).toBe(true);
    expect(find(drafts, /^2부 메인 스토리 Ex\. 로어추적/).periods).toEqual([]);
    expect(find(drafts, /^\[나의 집무실\]/).images).toHaveLength(1);
    expect(find(drafts, /Who Let The Fox Out/)).toMatchObject({
      category: "event",
      kind: "interval",
    });
  });

  test("6/23: encore recruitment and website events", () => {
    const drafts = parsePost(fixture("update-0623"));
    expect(find(drafts, /앙코르 모집$/).students).toHaveLength(10);
    expect(find(drafts, /주사위 게임/)).toMatchObject({
      label: "웹뷰 이벤트",
      category: "event",
      end: "2026-08-18T10:59:00+09:00",
    });
  });
});

describe("dedicated notices", () => {
  test("website opening announcements are excluded even with a labelled date", () => {
    const post = {
      ...fixture("welcome-open-ended"),
      title: "[나의 집무실] 정식 오픈 안내",
      blocks: noticeBlocks(
        "<p>8월 18일(화) ‘나의 집무실’ 웹페이지가 베타 버전을 지나 정식으로 오픈됩니다!</p><p>오픈 일시: 8월 18일(화) 점검 후 ~ 별도 안내 시까지</p>",
      ),
    };
    expect(parsePost(post)).toEqual([]);
  });

  test("pickup notice: groups, captions and banners", () => {
    const drafts = parsePost(fixture("pickup-1006"));
    expect(drafts.map((draft) => [draft.title, draft.images.length])).toEqual([
      ["카즈사(밴드), 요시미(밴드) 특별 픽업", 2],
      ["나츠(밴드) 픽업", 1],
    ]);
  });

  test("monthly campaign post including a row with two periods", () => {
    const drafts = parsePost(fixture("campaign-october"));
    expect(drafts).toHaveLength(10);
    expect(
      drafts
        .filter((draft) => draft.title === "계정 경험치 2배")
        .map((draft) => draft.start),
    ).toEqual(["2026-10-17T04:00:00+09:00", "2026-10-24T04:00:00+09:00"]);
  });

  test("coupon expiry becomes a deadline", () => {
    const [coupon] = parsePost(fixture("coupon-erica"));
    expect(coupon).toMatchObject({
      kind: "deadline",
      title: "에리카 합류 기념 특별 쿠폰 사용 마감",
      start: "2026-10-09T23:59:00+09:00",
    });
  });

  test("festival: all-day dates and a secondary period, not the daily opening hours", () => {
    const [festival] = parsePost(fixture("festival"));
    expect(festival).toMatchObject({
      category: "community",
      all_day: true,
      start: "2026-11-07",
      end: "2026-11-09",
    });
    expect(festival!.periods.map((period) => period.label)).toContain(
      "멤버십 번호 발급 일정",
    );
  });

  test("goods pre-orders remain scheduled", () => {
    expect(parsePost(fixture("figriq"))[0]).toMatchObject({
      category: "community",
      start: "2026-09-29T12:00:00+09:00",
      end: "2026-11-18T23:59:00+09:00",
    });
  });

  test("OST pre-orders retain stock-depletion ending and the goods sale period", () => {
    const [sale] = parsePost(fixture("ost-preorder"));
    expect(sale).toMatchObject({
      category: "community",
      kind: "interval",
      start: "2026-05-18T14:00:00+09:00",
      end_note: "소진 시까지",
    });
    expect(sale!.periods).toContainEqual(
      expect.objectContaining({
        start: "2026-05-22T15:00:00+09:00",
        end: "2026-06-10T23:59:00+09:00",
      }),
    );
    expect(eventsFromDrafts([sale!], NOW)).toHaveLength(1);
  });

  test("Red Cross campaigns retain their explicit stock-depletion ending", () => {
    for (const name of ["red-cross-first", "red-cross-second"]) {
      const [campaign] = parsePost(fixture(name));
      expect(campaign).toMatchObject({
        category: "community",
        kind: "interval",
        end_note: "소진 시까지",
      });
      expect(campaign!.end).toBeUndefined();
      const fresh = eventsFromDrafts([campaign!], NOW);
      expect(fresh).toHaveLength(1);
      expect(mergeArchive(fresh, [], new Set(), NOW).events).toEqual(fresh);
    }
  });

  test("shared card-collecting and cafe seasons stay until further notice", () => {
    for (const name of ["collecting-season", "cafe-season"]) {
      const [season] = parsePost(fixture(name));
      expect(season).toMatchObject({
        kind: "interval",
        end_note: "별도 안내 시까지",
      });
      expect(season!.title).toMatch(/시즌\s*\d+/);
      const fresh = eventsFromDrafts([season!], NOW);
      expect(fresh).toHaveLength(1);
      expect(mergeArchive(fresh, [], new Set(), NOW).events).toEqual(fresh);
    }
  });

  test("personal newcomer and returning-player campaigns are not shared calendar schedules", () => {
    for (const name of [
      "welcome-open-ended",
      "return-login-bonus",
      "return-welcome",
    ]) {
      expect(parsePost(fixture(name))).toEqual([]);
    }
    const personal = {
      ...fixture("welcome-open-ended"),
      title: "새로운 선생님 출석 이벤트",
    };
    expect(parsePost(personal)).toEqual([]);
  });

  test("shared login events with an end stay; open-ended activities are excluded", () => {
    const post = {
      ...fixture("return-login-bonus"),
      title: "5주년 로그인 보너스 이벤트",
      blocks: noticeBlocks(
        "<p>행사 기간: 10월 6일(화) ~ 10월 13일(화)</p><p>모든 선생님께 로그인 보너스를 드립니다.</p>",
      ),
    };
    expect(parsePost(post)[0]).toMatchObject({
      kind: "interval",
      start: "2026-10-06",
      end: "2026-10-14",
    });
    expect(
      parsePost({
        ...post,
        title: "특별 미션 이벤트",
        blocks: noticeBlocks(
          "<p>행사 기간: 10월 6일(화) 점검 후 ~ 별도 안내 시까지</p>",
        ),
      }),
    ).toEqual([]);
  });

  test("ignores account restriction lists", () => {
    expect(parsePost(fixture("restriction"))).toEqual([]);
  });
});

describe("feed building", () => {
  const posts = [
    "update-0929",
    "maintenance-0929",
    "pickup-1006",
    "campaign-october",
    "coupon-erica",
  ].map(fixture);
  const drafts = posts.flatMap(parsePost);
  const events = eventsFromDrafts(drafts, NOW);

  test("one event per real-world schedule, with every notice as a source", () => {
    const natsu = events.filter((event) => event.title === "나츠(밴드) 픽업");
    expect(natsu).toHaveLength(1);
    expect(natsu[0]!.sources.map((source) => source.board)).toEqual([
      "공지사항",
      "업데이트",
    ]);
    expect(
      events.filter((event) => event.title === "9/29 업데이트 정기점검"),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.title === "스케쥴 2배" && event.start.startsWith("2026-09-29"),
      ),
    ).toHaveLength(1);
  });

  test('"점검 후" starts resolve to the announced maintenance end', () => {
    const story = events.find((event) =>
      event.title.startsWith("백에서 피어난"),
    )!;
    expect(story).toMatchObject({
      start: "2026-09-29T14:00:00+09:00",
      start_after_maintenance: true,
    });
    expect(story.periods![0]!.start).toBe("2026-09-29T14:00:00+09:00");
  });

  test("IDs are stable across runs and the archive keeps first_seen", () => {
    const again = eventsFromDrafts(
      posts.flatMap(parsePost),
      "2026-10-13T00:00:00.000Z",
    );
    expect(again.map((event) => event.id).sort()).toEqual(
      events.map((event) => event.id).sort(),
    );
    const urls = new Set(posts.map((post) => post.url));
    const { events: merged, report } = mergeArchive(
      events,
      again,
      urls,
      "2026-10-13T00:00:00.000Z",
    );
    expect(report).toMatchObject({ added: [], changed: [], removed: [] });
    expect(merged.every((event) => event.first_seen === NOW)).toBe(true);
  });

  test("events from notices outside the window are kept; corrected notices drop stale events", () => {
    const old = {
      ...events[0]!,
      id: "event-20260101-00000000",
      sources: [
        {
          ...events[0]!.sources[0]!,
          url: "https://forum.nexon.com/bluearchive/board_view?board=1039&thread=1",
        },
      ],
    };
    old.source_url = old.sources[0]!.url;
    const stale = { ...events[1]!, id: "event-20260102-00000000" };
    const { events: merged, report } = mergeArchive(
      [...events, old, stale],
      events,
      new Set(posts.map((post) => post.url)),
      NOW,
    );
    expect(merged.map((event) => event.id)).toContain(old.id);
    expect(report.removed.map((event) => event.id)).toEqual([stale.id]);
  });

  test("open-ended seasons age out of the archive after about one season", () => {
    const season = (id: string, start: string) => ({
      ...events[0]!,
      id,
      title: "[카페 메모리얼] 시즌 4 오픈",
      kind: "interval" as const,
      all_day: true,
      start,
      end: undefined,
      end_note: "별도 안내 시까지",
      sources: [
        {
          ...events[0]!.sources[0]!,
          url: "https://forum.nexon.com/bluearchive/board_view?board=1039&thread=1",
        },
      ],
    });
    const recent = season("event-20260501-00000000", "2026-05-01");
    const old = season("event-20260301-00000000", "2026-03-01");
    const { events: merged } = mergeArchive([recent, old], [], new Set(), NOW);
    expect(merged.map((event) => event.id)).toEqual([recent.id]);
  });

  test("open-ended seasons older than 180 days are dropped even when re-scraped", () => {
    const season = {
      ...events[0]!,
      id: "event-20260301-00000000",
      title: "[카페 메모리얼] 시즌 3 오픈",
      kind: "interval" as const,
      all_day: true,
      start: "2026-03-01",
      end: undefined,
      end_note: "별도 안내 시까지",
    };
    const { events: merged, report } = mergeArchive(
      [],
      [season],
      new Set(season.sources.map((item) => item.url)),
      NOW,
    );
    expect(merged).toEqual([]);
    expect(report.added).toEqual([]);
  });

  test("announcement rules remove archived entries even when their notices are outside the fetch window", () => {
    const announcement = {
      ...events[0]!,
      id: "event-20260818-44105748",
      title: "[나의 집무실] 정식 오픈",
      label: undefined,
      description: "나의 집무실 웹페이지가 정식으로 오픈됩니다!",
      kind: "interval" as const,
      end: undefined,
    };
    const { events: merged, report } = mergeArchive(
      [...events, announcement],
      [announcement],
      new Set(),
      NOW,
    );
    expect(merged.map((event) => event.id)).not.toContain(announcement.id);
    expect(report.removed).toEqual([announcement]);
    expect(report.kept).toBe(events.length);
  });

  test("personal campaigns are removed from the archive without re-fetching their notices", () => {
    const personal = {
      ...events[0]!,
      id: "event-20260526-8eceeb76",
      title: "업무 복귀 로그인 보너스! 이벤트",
      end: undefined,
    };
    const { events: merged, report } = mergeArchive(
      [...events, personal],
      [],
      new Set(),
      NOW,
    );
    expect(merged).not.toContainEqual(personal);
    expect(report.removed).toEqual([personal]);
  });

  test("the feed validates and keeps generated_at when nothing changed", () => {
    const feed = buildFeed(events, null, NOW);
    expect(feed.generated_at).toBe(NOW);
    expect(
      buildFeed(events, feed, "2026-10-13T00:00:00.000Z").generated_at,
    ).toBe(NOW);
  });
});
