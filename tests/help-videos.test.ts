import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MARKETING_PAGES } from "../worker/content";
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

  it("cache-busts every portal clip and poster at v=10", () => {
    expect(videos.length).toBe(22);
    for (const video of videos) {
      expect(video.file, video.slug).toMatch(/\.mp4\?v=10$/);
      expect(video.poster, video.slug).toMatch(/\.jpg\?v=10$/);
      expect(video.file, video.slug).toBe(`${video.slug}.mp4?v=10`);
      expect(video.poster, video.slug).toBe(`${video.slug}.jpg?v=10`);
    }
    expect(html.slice(html.indexOf("var SCHEDI_HELP_VIDEOS"), html.indexOf("var SCHEDI_HELP_VIDEO_GROUPS"))).not.toMatch(/\?v=(?!10)\d+/);
  });

  it("renames the reports and time-off clips and adds the booking QR code", () => {
    expect(bySlug.get("owner-07-appointments-report")?.title).toBe("Reports");
    expect(bySlug.get("owner-13-date-blocks")?.title).toBe("Time off and vacation");
    expect(bySlug.get("owner-21-booking-qr-code")).toMatchObject({
      title: "Booking QR code",
      desc: "How to show, generate, download or print, and save your booking QR code.",
      file: "owner-21-booking-qr-code.mp4?v=10",
      poster: "owner-21-booking-qr-code.jpg?v=10",
      aud: "owner",
    });
    const setup = portal.groups?.find((group) => group[0] === "Get set up");
    expect(setup?.[1]).toContain("owner-21-booking-qr-code");
    const listed = new Set((portal.groups || []).flatMap((group) => group[1]));
    for (const video of videos) expect(listed.has(video.slug), video.slug).toBe(true);
  });

  it("sizes the portal player for a portrait 720x1280 frame", () => {
    const player = portal.player || "";
    expect(player).toContain('class="schedi-help-video-frame');
    expect(player).toContain('width="720"');
    expect(player).toContain('height="1280"');
    expect(player).toContain("object-contain");
    expect(player).toContain('poster="/assets/help-videos/client-booking-demo.jpg?v=10"');
    expect(player).toContain('src="/assets/help-videos/client-booking-demo.mp4?v=10"');
    expect(html).toContain("aspect-ratio: 9 / 16");
    expect(html).toContain("object-fit: contain");
  });

  it("cache-busts the public help page and keeps portrait markup", () => {
    const page = MARKETING_PAGES.find((item) => item.path === "/help");
    const rendered = renderMarketingPage(page!);
    const sources = rendered.match(/\/assets\/help-videos\/[^"']+/g) || [];
    expect(sources.length).toBe(44);
    for (const url of sources) expect(url).toMatch(/\.(mp4|jpg)\?v=10$/);
    expect(rendered).toContain(">Reports<");
    expect(rendered).toContain(">Time off and vacation<");
    expect(rendered).not.toContain("Appointments report");
    expect(rendered).not.toContain("Vacation and date blocks");
    expect(rendered).toContain("/assets/help-videos/owner-20-booking-alerts-iphone.mp4?v=10");
    expect(rendered).toContain("/assets/help-videos/owner-20-booking-alerts-iphone.jpg?v=10");
    expect(rendered).toContain("/assets/help-videos/owner-21-booking-qr-code.mp4?v=10");
    expect(rendered).toContain("/assets/help-videos/owner-21-booking-qr-code.jpg?v=10");
    expect(rendered).toContain("How to show, generate, download or print, and save your booking QR code.");
    expect(rendered).toContain('width="720" height="1280"');
    expect(rendered).toContain("playsinline");
    expect(rendered).toContain("aspect-ratio:9/16");
    expect(rendered).toContain("object-fit:contain");
    expect(rendered).not.toMatch(/<strong>Booking QR code<\/strong> \(\)/);
  });
});
