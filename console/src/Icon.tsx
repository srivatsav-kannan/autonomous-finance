type IconName = "inbox" | "org" | "activity" | "ledger" | "memory" | "evals" | "control" | "search" | "chevron" | "check" | "download" | "file" | "arrow";
const paths: Record<IconName, string> = {
  inbox: "M4 4h16v16H4z M4 13h5l2 3h2l2-3h5",
  org: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  ledger: "M4 3h16v18H4z M9 3v18 M9 9h11 M9 15h11",
  memory: "M4 4h7l2 3h7v13H4z M8 12h8 M8 16h5",
  evals: "M4 3h16v18H4z M8 8l1 1 2-2 M13 8h3 M8 15l1 1 2-2 M13 15h3",
  control: "M4 7h16 M4 17h16 M9 4v6 M15 14v6",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5",
  file: "M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h6",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
};
export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
