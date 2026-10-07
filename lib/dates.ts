export function chinaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function displayDate(value: string | null): string {
  if (!value) return "未安排";
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}
