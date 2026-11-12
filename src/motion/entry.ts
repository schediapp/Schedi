import { animate, hover, inView, stagger } from "motion";

const RISE = { duration: 0.42, ease: "easeOut" as const };
const HOVER = { duration: 0.16, ease: "easeOut" as const };

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function play(selector: string, keyframes: { transform: string | string[] }, options: { duration: number; ease: "easeOut"; delay?: ReturnType<typeof stagger> }) {
  if (!document.querySelector(selector)) return;
  animate(selector, keyframes, options);
}

function bootMarketing() {
  play(".hero-copy > *", { transform: ["translateY(10px)", "translateY(0px)"] }, { ...RISE, delay: stagger(0.05) });
  play(".mock", { transform: ["translateY(14px)", "translateY(0px)"] }, { ...RISE, duration: 0.5 });
  play(".hero-sec.slim h1, .plain > article > h1, img.hero", { transform: ["translateY(8px)", "translateY(0px)"] }, RISE);

  if (document.querySelector(".feature, .steps > li, .plan, .band, .faq")) {
    inView(
      ".feature, .steps > li, .plan, .band, .faq",
      (element) => {
        if (reducedMotion()) return;
        animate(element, { transform: ["translateY(12px)", "translateY(0px)"] }, RISE);
      },
      { margin: "0px 0px -8% 0px" },
    );
  }

  hover(".feature, .plan", (element) => {
    if (reducedMotion()) return;
    animate(element, { transform: "translateY(-3px)" }, HOVER);
    return () => {
      animate(element, { transform: "translateY(0px)" }, HOVER);
    };
  });
}

const OWNER_PANELS: Record<string, string> = {
  today: "schediTodayPanel",
  appointments: "tenantSectionRoster",
  services: "tenantSectionServices",
  hours: "tenantSectionHours",
  profile: "tenantSectionHours",
  payments: "tenantSectionPayments",
  emails: "tenantSectionNotifications",
  reports: "tenantSectionReport",
  clients: "tenantSectionClients",
  account: "tenantMoreCard",
  billing: "tenantBillingCard",
};

function shown(element: HTMLElement | null): boolean {
  return !!element && !element.classList.contains("hidden") && element.getAttribute("hidden") == null;
}

function bootOwner() {
  const portal = document.getElementById("tenantPortalSection");
  if (!portal) return;
  const login = document.getElementById("tenantLoginBox");
  const dash = document.getElementById("tenantDashboard");
  let loginPlayed = false;
  let dashPlayed = false;
  let dashName = portal.getAttribute("data-dash");

  function maybeLogin() {
    if (loginPlayed || reducedMotion() || !shown(portal) || !shown(login)) return;
    loginPlayed = true;
    animate(login as HTMLElement, { transform: ["translateY(8px)", "translateY(0px)"] }, RISE);
  }

  function maybeDash() {
    if (dashPlayed || reducedMotion() || !shown(portal) || !shown(dash)) return;
    dashPlayed = true;
    play("#schediDashSidebar .sd-nav button", { transform: ["translateX(-6px)", "translateX(0px)"] }, { ...RISE, duration: 0.28, delay: stagger(0.025) });
    play(
      "#schediTodayPanel .sd-glance, #schediTodayPanel .sd-wait, #schediTodayPanel .sd-agenda, #schediTodayPanel .sd-ready",
      { transform: ["translateY(8px)", "translateY(0px)"] },
      { ...RISE, duration: 0.34, delay: stagger(0.05) },
    );
  }

  const watch = new MutationObserver(() => {
    maybeLogin();
    maybeDash();
    const next = portal.getAttribute("data-dash");
    if (dashPlayed && next && next !== dashName && !reducedMotion()) {
      const panel = document.getElementById(OWNER_PANELS[next] || "");
      if (panel) animate(panel, { transform: ["translateY(6px)", "translateY(0px)"] }, { duration: 0.22, ease: "easeOut" });
    }
    dashName = next;
  });
  watch.observe(portal, { attributes: true, attributeFilter: ["class", "data-dash", "hidden"] });
  if (login) watch.observe(login, { attributes: true, attributeFilter: ["class", "hidden"] });
  if (dash) watch.observe(dash, { attributes: true, attributeFilter: ["class", "hidden"] });

  const report = document.getElementById("tenantReportBody");
  if (report) {
    new MutationObserver(() => {
      if (reducedMotion()) return;
      if (!report.querySelector(".sd-report-card, .sd-report-chart")) return;
      play(
        "#tenantReportBody .sd-report-card, #tenantReportBody .sd-report-chart",
        { transform: ["translateY(8px)", "translateY(0px)"] },
        { ...RISE, duration: 0.28, delay: stagger(0.03) },
      );
    }).observe(report, { childList: true });
  }

  hover("#schediDashSidebar .sd-nav button", (element) => {
    if (reducedMotion()) return;
    animate(element, { transform: "translateX(2px)" }, HOVER);
    return () => {
      animate(element, { transform: "translateX(0px)" }, HOVER);
    };
  });

  maybeLogin();
  maybeDash();
}

function bootHq() {
  const glance = document.getElementById("hqGlanceCard");
  const nav = document.querySelector(".hq-nav-btn, #hqNewTabs button");
  if (!glance && !nav && !document.getElementById("agencyMasterLoginBox")) return;

  let played = false;
  function reveal() {
    if (played || reducedMotion()) return;
    const login = document.getElementById("agencyMasterLoginBox");
    const loginOpen = login && !login.classList.contains("hidden");
    if (loginOpen) {
      played = true;
      animate(login, { transform: ["translateY(8px)", "translateY(0px)"] }, RISE);
      return;
    }
    if (glance && (glance as HTMLElement).offsetParent === null && login && !loginOpen) return;
    played = true;
    play(".hq-nav-btn, #hqNewTabs button", { transform: ["translateX(-6px)", "translateX(0px)"] }, { ...RISE, duration: 0.28, delay: stagger(0.03) });
    if (glance) animate(glance, { transform: ["translateY(8px)", "translateY(0px)"] }, RISE);
  }

  const login = document.getElementById("agencyMasterLoginBox");
  if (login) {
    new MutationObserver(reveal).observe(login, { attributes: true, attributeFilter: ["class", "hidden"] });
  }
  reveal();

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || reducedMotion()) return;
    const button = target.closest("[data-hq-go]");
    if (!button) return;
    const id = button.getAttribute("data-hq-go");
    const panel = id ? document.getElementById(id) : null;
    if (!panel) return;
    animate(panel, { transform: ["translateY(6px)", "translateY(0px)"] }, { duration: 0.22, ease: "easeOut" });
  });
}

function start() {
  document.documentElement.classList.add("schedi-motion-on");
  if (reducedMotion()) return;
  if (document.querySelector(".hero-sec, .site-header")) bootMarketing();
  if (document.getElementById("tenantPortalSection")) bootOwner();
  if (document.getElementById("agencyHqSection") || document.getElementById("hqGlanceCard") || document.querySelector(".hq-nav-btn")) {
    bootHq();
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
