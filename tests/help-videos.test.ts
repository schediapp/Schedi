import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { helpVideoFigcaption, MARKETING_PAGES } from "../worker/content";
import { renderMarketingPage } from "../worker/render";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

type HelpVideo = {
  slug: string;
  file: string;
  poster: string;
  title: string;
  desc: string;
  dur: string;
  aud: string;
  kind?: string;
};

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

  it("cache-busts every portal clip and poster at v=13", () => {
    expect(videos.length).toBe(23);
    for (const video of videos) {
      expect(video.file, video.slug).toMatch(/\.mp4\?v=13$/);
      expect(video.poster, video.slug).toMatch(/\.jpg\?v=13$/);
      expect(video.file, video.slug).toBe(`${video.slug}.mp4?v=13`);
      expect(video.poster, video.slug).toBe(`${video.slug}.jpg?v=13`);
    }
    expect(html.slice(html.indexOf("var SCHEDI_HELP_VIDEOS"), html.indexOf("var SCHEDI_HELP_VIDEO_GROUPS"))).not.toMatch(/\?v=(?!13)\d+/);
  });

  it("renames the reports and time-off clips and adds the booking QR code", () => {
    expect(bySlug.get("owner-07-appointments-report")?.title).toBe("Reports");
    expect(bySlug.get("owner-08-add-manual-appointment")?.dur).toBe("0:22");
    expect(bySlug.get("owner-04-payment-options")?.dur).toBe("0:28");
    expect(bySlug.get("owner-13-date-blocks")?.title).toBe("Time off and vacation");
    expect(bySlug.get("owner-21-booking-qr-code")).toMatchObject({
      title: "Booking QR code",
      desc: "How to show, generate, download or print, and save your booking QR code.",
      file: "owner-21-booking-qr-code.mp4?v=13",
      poster: "owner-21-booking-qr-code.jpg?v=13",
      aud: "owner",
    });
    const setup = portal.groups?.find((group) => group[0] === "Get set up");
    expect(setup?.[1]).toContain("owner-21-booking-qr-code");
    const android = bySlug.get("owner-22-booking-alerts-android");
    expect(android).toMatchObject({
      title: "Booking alerts on Android (Chrome)",
      desc: "Turn on a pop-up in Chrome on Android when a booking comes in.",
      dur: "0:29",
      file: "owner-22-booking-alerts-android.mp4?v=13",
      poster: "owner-22-booking-alerts-android.jpg?v=13",
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

  it("sizes the portal player for a portrait 720x1280 frame", () => {
    const player = portal.player || "";
    expect(player).toContain('class="schedi-help-video-frame');
    expect(player).toContain('width="720"');
    expect(player).toContain('height="1280"');
    expect(player).toContain("object-contain");
    expect(player).toContain('poster="/assets/help-videos/client-booking-demo.jpg?v=13"');
    expect(player).toContain('src="/assets/help-videos/client-booking-demo.mp4?v=13"');
    expect(html).toContain("aspect-ratio: 9 / 16");
    expect(html).toContain("object-fit: contain");
  });

  it("cache-busts owner clips on the public help page at v=14 and keeps portrait markup", () => {
    const page = MARKETING_PAGES.find((item) => item.path === "/help");
    const rendered = renderMarketingPage(page!);
    const sources = rendered.match(/\/assets\/help-videos\/[^"']+/g) || [];
    expect(sources.length).toBe(46);
    const ownerSources = sources.filter((url) => !url.includes("/client-booking-demo."));
    const clientSources = sources.filter((url) => url.includes("/client-booking-demo."));
    expect(ownerSources).toHaveLength(44);
    expect(clientSources).toHaveLength(2);
    for (const url of ownerSources) expect(url, url).toMatch(/\.(mp4|jpg)\?v=14$/);
    for (const url of clientSources) expect(url, url).toMatch(/\.(mp4|jpg)\?v=13$/);
    expect(rendered).toContain(">Reports<");
    expect(rendered).toContain(">Time off and vacation<");
    expect(rendered).not.toContain("Appointments report");
    expect(rendered).not.toContain("Vacation and date blocks");
    expect(rendered).toContain("/assets/help-videos/owner-20-booking-alerts-iphone.mp4?v=14");
    expect(rendered).toContain("/assets/help-videos/owner-20-booking-alerts-iphone.jpg?v=14");
    expect(rendered).toContain("/assets/help-videos/owner-22-booking-alerts-android.mp4?v=14");
    expect(rendered).toContain("/assets/help-videos/owner-22-booking-alerts-android.jpg?v=14");
    expect(rendered).toContain("<strong>Booking alerts on Android (Chrome)</strong> (0:29). Turn on a pop-up in Chrome on Android when a booking comes in.");
    expect(rendered.indexOf("owner-22-booking-alerts-android")).toBeGreaterThan(rendered.indexOf("owner-20-booking-alerts-iphone"));
    expect(rendered.indexOf("owner-22-booking-alerts-android")).toBeLessThan(rendered.indexOf("owner-21-booking-qr-code"));
    expect(rendered).toContain("/assets/help-videos/owner-21-booking-qr-code.mp4?v=14");
    expect(rendered).toContain("/assets/help-videos/owner-21-booking-qr-code.jpg?v=14");
    expect(rendered).toContain("How to show, generate, download or print, and save your booking QR code.");
    expect(rendered).toContain("<strong>Booking alerts on iPhone</strong> (0:20). Turn on a pop-up on your iPhone when a booking comes in.");
    expect(rendered).toContain("<strong>Add a walk-in or phone booking</strong> (0:22). Log a walk-in or phone booking with the Walk-in toggle, saved-client suggest, open time slot, and payment status.");
    expect(rendered).toContain("<strong>Booking QR code</strong> (0:25). How to show, generate, download or print, and save your booking QR code.");
    expect(rendered).not.toMatch(/<\/strong> \./);
    expect(rendered).toContain('width="720" height="1280"');
    expect(rendered).toContain("playsinline");
    expect(rendered).toContain("aspect-ratio:9/16");
    expect(rendered).toContain("object-fit:contain");
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
