export const reportConfig = {
  staleDays: 10, // N: stale if no activity (beyond created) for >= N days AND status in open/waiting_on_me/waiting_on_other
  dueSoonDays: 7, // due within (now, now+7d]
  needsYouHours: 48, // open loops with dueAt <= now+48h join "Needs you"
  recentlyDoneDays: 7, // done loops with updatedAt >= now-7d
} as const;

export type ReportConfig = typeof reportConfig;
