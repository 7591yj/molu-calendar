import { sitePath } from "../lib/urls.ts";
import { Icon } from "./Icon.tsx";
import { Dialog, dialogHeading, dialogLead } from "./ui.tsx";

const LINKS = [
  ["공식 커뮤니티", "https://forum.nexon.com/bluearchive"],
  ["공식 홈페이지", "https://bluearchive.nexon.com"],
  ["events.json", sitePath("data/events.json")],
  ["데이터 형식", sitePath("schema.json")],
  ["GitHub", "https://github.com/faransansj/molu-calendar"],
] as const;

export function SourcesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="데이터 안내"
      icon="info"
      labelledBy="sources-title"
      className="w-[520px]"
    >
      <h2 id="sources-title" className={dialogHeading}>
        데이터와 출처
      </h2>
      <p className={dialogLead}>
        블루 아카이브 한국 서버 공식 커뮤니티의 공지사항·업데이트·진행 이벤트를
        매주 읽어 정리해요. 정확한 내용은 각 일정의 원문 공지를 확인해 주세요.
        NEXON / NEXON Games와 관련 없는 비공식 팬 프로젝트예요.
      </p>
      <nav
        className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3.5 text-sm font-semibold"
        aria-label="데이터와 출처"
      >
        {LINKS.map(([label, href]) => {
          const external = href.startsWith("https:");
          return (
            <a
              key={href}
              href={href}
              className="inline-flex min-h-8 items-center gap-1 text-blue underline-offset-2 hover:underline [&_.icon]:size-[13px]"
              {...(external && {
                target: "_blank",
                rel: "noopener noreferrer",
              })}
            >
              {label}
              {external && <Icon name="external" />}
            </a>
          );
        })}
      </nav>
    </Dialog>
  );
}
