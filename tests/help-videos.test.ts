import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { helpVideoFigcaption, MARKETING_PAGES } from "../worker/content";
import { renderMarketingPage } from "../worker/render";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

type HelpVideo = {
  slug: string;
  youtube: string;
  title: string;
  desc: string;
  aud: string;
  kind?: string;
};

const YOUTUBE_IDS: Record<string, string> = {
  "owner-01-create-your-page": "yNJtA9wL8qs",
  "owner-02-add-services": "7Y7uGEvwg_s",
  "owner-03-set-hours": "3Ex4KCp3Zs8",
  "owner-04-payment-options": "NYM3Je9uUJM",
  "owner-05-share-booking-link": "AqnT6IzHBDA",
  "owner-06-accept-booking-request": "-0b0YbF_IQM",
  "owner-07-appointments-report": "zlCenICbH4I",
  "owner-08-add-manual-appointment": "pcpRcfC_fzk",
  "owner-09-mark-paid": "mnR8HKGWjMU",
  "owner-10-reschedule": "iGYcWapWtgk",
  "owner-11-cancel-appointment": "XaDSbt_ZmCc",
  "owner-12-special-hours": "Wcb5zxcK7GQ",
  "owner-13-date-blocks": "kCqibgh1Hqs",
  "owner-14-email-confirmations": "Mvv-HA2FCKE",
  "owner-15-recurring-visits-pro": "JK5bSzWVqEI",
  "owner-16-clients": "HSQCYOsfFew",
  "owner-17-import-clients-csv": "xz-4TRvbn8g",
  "owner-18-compare-plans": "TOCtKB3d0oE",
  "owner-19-roster-week-month": "BW8vpUKWi3w",
  "owner-20-booking-alerts-iphone": "8C3iOPUqtLI",
  "owner-21-booking-qr-code": "BCD73CkqOF4",
  "owner-22-booking-alerts-android": "CpBaxKk6dLs",
  "client-booking-demo": "F-mLaXTWN_E",
};

const BANNED_YOUTUBE_IDS = [
  "qXyxXLFW2ho",
  "qBoXgPSFf8I",
  "k93khK1uVvI",
  "6_fBtVgna5g",
  "QO_k5jLoGtU",
  "-nPj7ANebAs",
  "CXDzWnTyaQc",
];

function embedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

function portalCatalog() {
  const start = html.indexOf("var SCHEDI_HELP_VIDEOS");
  const end = html.indexOf("function schediHelpVideoCard");
  const sandbox: { videos?: HelpVideo[]; groups?: [string, string[]][]; player?: string } = {};
  runInNewContext(`${html.slice(start, end)}
    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    this.videos = SCHEDI_HELP_VIDEOS;
    this.groups = SCHEDI_HELP_VIDEO_GROUPS;
    this.player = schediHelpVideoPlayer(SCHEDI_HELP_VIDEOS[0]);
  `, sandbox);
  return sandbox;
}

describe("Help page videos", () => {
  const portal = portalCatalog();
  const videos = portal.videos || [];
  const bySlug = new Map(videos.map((video) => [video.slug, video]));

  it("embeds all 23 YouTube videos and no local mp4s", () => {
    expect(videos.length).toBe(23);
    expect(Object.keys(YOUTUBE_IDS)).toHaveLength(23);
    const catalog = html.slice(html.indexOf("var SCHEDI_HELP_VIDEOS"), html.indexOf("var SCHEDI_HELP_VIDEO_GROUPS"));
    for (const video of videos) {
      expect(video.youtube, video.slug).toBe(YOUTUBE_IDS[video.slug]);
      expect(video.youtube, video.slug).toMatch(/^[A-Za-z0-9_-]{6,}$/);
      expect(BANNED_YOUTUBE_IDS, video.slug).not.toContain(video.youtube);
    }
    expect(new Set(videos.map((video) => video.slug))).toEqual(new Set(Object.keys(YOUTUBE_IDS)));
    expect(catalog).not.toMatch(/\.mp4/);
    expect(catalog).not.toMatch(/poster/);
    expect(catalog).not.toMatch(/\?v=/);
    for (const id of BANNED_YOUTUBE_IDS) expect(catalog, id).not.toContain(id);

    const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
    const hqCatalog = hq.slice(hq.indexOf("var SCHEDI_HELP_VIDEOS"), hq.indexOf("var SCHEDI_HELP_VIDEO_GROUPS"));
    const hqIds = [...hqCatalog.matchAll(/"youtube": "([^"]+)"/g)].map((match) => match[1]);
    expect(hqIds).toHaveLength(20);
    for (const id of hqIds) {
      expect(Object.values(YOUTUBE_IDS), id).toContain(id);
      expect(BANNED_YOUTUBE_IDS, id).not.toContain(id);
    }
    expect(hqCatalog).not.toMatch(/\.mp4/);
    expect(hq).toContain("https://www.youtube-nocookie.com/embed/");
  });

  it("renames the reports and time-off clips and adds the booking QR code", () => {
    expect(bySlug.get("owner-07-appointments-report")?.title).toBe("Reports");
    expect(bySlug.get("owner-08-add-manual-appointment")?.title).toBe("Add a walk-in or phone booking");
    expect(bySlug.get("owner-04-payment-options")?.title).toBe("Payment options");
    expect(bySlug.get("owner-13-date-blocks")?.title).toBe("Time off and vacation");
    expect(bySlug.get("owner-21-booking-qr-code")).toMatchObject({
      title: "Booking QR code",
      desc: "How to show, generate, download or print, and save your booking QR code.",
      youtube: "BCD73CkqOF4",
      aud: "owner",
    });
    const setup = portal.groups?.find((group) => group[0] === "Get set up");
    expect(setup?.[1]).toContain("owner-21-booking-qr-code");
    const android = bySlug.get("owner-22-booking-alerts-android");
    expect(android).toMatchObject({
      title: "Booking alerts on Android (Chrome)",
      desc: "Turn on a pop-up in Chrome on Android when a booking comes in.",
      youtube: "CpBaxKk6dLs",
      aud: "owner",
    });
    expect(android?.kind).toBeUndefined();
    const order = videos.map((video) => video.slug);
    expect(order.indexOf("owner-22-booking-alerts-android")).toBe(order.indexOf("owner-20-booking-alerts-iphone") + 1);
    const emails = portal.groups?.find((group) => group[0] === "Emails and Pro features");
    expect(emails?.[1].indexOf("owner-22-booking-alerts-android")).toBe((emails?.[1].indexOf("owner-20-booking-alerts-iphone") ?? -2) + 1);
    const listed = new Set((portal.groups || []).flatMap((group) => group[1]));
    for (const video of videos) expect(listed.has(video.slug), video.slug).toBe(true);
  });

  it("sizes the portal player as a portrait 9:16 YouTube embed", () => {
    const player = portal.player || "";
    expect(player).toContain('class="schedi-help-video-frame');
    expect(player).toContain(`src="${embedUrl("F-mLaXTWN_E")}"`);
    expect(player).toContain('title="How clients book"');
    expect(player).toContain('loading="lazy"');
    expect(player).toContain('allow="accelerometer; encrypted-media; picture-in-picture"');
    expect(player).toContain("allowfullscreen");
    expect(player).not.toContain("<video");
    expect(player).not.toContain(".mp4");
    expect(html).toContain("aspect-ratio: 9 / 16");
  });

  it("embeds every public help clip from YouTube and keeps portrait markup", () => {
    const page = MARKETING_PAGES.find((item) => item.path === "/help");
    const rendered = renderMarketingPage(page!);
    const sources = rendered.match(/https:\/\/www\.youtube-nocookie\.com\/embed\/[^"']+/g) || [];
    expect(sources).toHaveLength(23);
    expect(new Set(sources)).toEqual(new Set(Object.values(YOUTUBE_IDS).map(embedUrl)));
    expect(rendered).not.toMatch(/\.mp4/);
    expect(rendered).not.toContain("<video");
    expect(rendered).not.toContain("/assets/help-videos/");
    for (const id of BANNED_YOUTUBE_IDS) expect(rendered, id).not.toContain(id);
    expect(rendered).toContain(">Reports<");
    expect(rendered).toContain(">Time off and vacation<");
    expect(rendered).not.toContain("Appointments report");
    expect(rendered).not.toContain("Vacation and date blocks");
    expect(rendered).toContain(`src="${embedUrl("8C3iOPUqtLI")}"`);
    expect(rendered).toContain('title="Booking alerts on iPhone"');
    expect(rendered).toContain(`src="${embedUrl("CpBaxKk6dLs")}"`);
    expect(rendered).toContain("<strong>Booking alerts on Android (Chrome)</strong>. Turn on a pop-up in Chrome on Android when a booking comes in.");
    expect(rendered.indexOf("owner-22-booking-alerts-android")).toBeGreaterThan(rendered.indexOf("owner-20-booking-alerts-iphone"));
    expect(rendered.indexOf("owner-22-booking-alerts-android")).toBeLessThan(rendered.indexOf("owner-21-booking-qr-code"));
    expect(rendered).toContain(`src="${embedUrl("BCD73CkqOF4")}"`);
    expect(rendered).toContain("How to show, generate, download or print, and save your booking QR code.");
    expect(rendered).toContain("<strong>Booking alerts on iPhone</strong>. Turn on a pop-up on your iPhone when a booking comes in.");
    expect(rendered).toContain("<strong>Add a walk-in or phone booking</strong>. Log a walk-in or phone booking with the Walk-in toggle, saved-client suggest, open time slot, and payment status.");
    expect(rendered).toContain("<strong>Booking QR code</strong>. How to show, generate, download or print, and save your booking QR code.");
    expect(rendered).not.toMatch(/<\/strong> \./);
    expect(rendered).not.toMatch(/\(\d+:\d+\)/);
    expect(rendered).toContain('loading="lazy"');
    expect(rendered).toContain('allow="accelerometer; encrypted-media; picture-in-picture"');
    expect(rendered).toContain("allowfullscreen");
    expect(rendered).toContain("aspect-ratio:9/16");
  });

  it("drops the duration separator when a caption has no duration", () => {
    expect(helpVideoFigcaption("Booking alerts on iPhone", "", "Turn on a pop-up.")).toBe(
      "<strong>Booking alerts on iPhone</strong>. Turn on a pop-up.",
    );
    expect(helpVideoFigcaption("Booking QR code", "   ", "Save your code.")).toBe(
      "<strong>Booking QR code</strong>. Save your code.",
    );
    expect(helpVideoFigcaption("Booking QR code", "0:25", "Save your code.")).toBe(
      "<strong>Booking QR code</strong> (0:25). Save your code.",
    );
  });
});
