import type { UiLanguage } from "../types";

export function resolvePromptLanguage(language?: UiLanguage): UiLanguage {
  return language === "zh" ? "zh" : "en";
}

export function buildNowContextLine(language?: UiLanguage) {
  const lang = resolvePromptLanguage(language);
  const now = new Date();
  const utc = now.toISOString();
  const shanghai = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  if (lang === "zh") {
    return `当前时间（UTC）：${utc}\n当前时间（Asia/Shanghai）：${shanghai}`;
  }
  return `Current time (UTC): ${utc}\nCurrent time (Asia/Shanghai): ${shanghai}`;
}
