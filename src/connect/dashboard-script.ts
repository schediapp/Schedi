/**
 * Browser loader for the same Connect embedded components the Next portal
 * mounts: notification banner, onboarding, account management, payments, and
 * payouts. It runs only in the browser and asks this origin for a client secret.
 */
export const CONNECT_DASHBOARD_JS = String.raw`(function () {
  var root = document.getElementById("connect-stack");
  var key = root && root.getAttribute("data-publishable-key");
  if (!root || !key) return;
  function showError(message) {
    var p = document.createElement("p");
    p.className = "banner bad";
    p.setAttribute("role", "alert");
    p.textContent = message || "Stripe could not load.";
    root.appendChild(p);
  }
  var script = document.createElement("script");
  script.src = "https://connect-js.stripe.com/v1.0/connect.js";
  script.async = true;
  script.onload = function () {
    var stripeConnect = window.StripeConnect;
    if (!stripeConnect || typeof stripeConnect.init !== "function") {
      showError("Stripe could not load.");
      return;
    }
    var secretPromise;
    function fetchClientSecret() {
      if (!secretPromise) {
        secretPromise = fetch("/api/connect/session", { method: "POST", credentials: "same-origin" }).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok || !body || !body.clientSecret) {
              throw new Error((body && body.error) || "Could not open Stripe onboarding.");
            }
            return body.clientSecret;
          });
        });
      }
      return secretPromise;
    }
    var instance;
    try {
      instance = stripeConnect.init({
        publishableKey: key,
        fetchClientSecret: fetchClientSecret,
        appearance: {
          overlays: "dialog",
          variables: { colorPrimary: "#0e6b62", colorBackground: "#fffdf8", borderRadius: "12px" }
        }
      });
    } catch (error) {
      showError(error && error.message ? error.message : "Stripe could not load.");
      return;
    }
    if (!instance || !instance.connect) {
      showError("Stripe could not load.");
      return;
    }
    var parts = [
      ["notification-banner", ""],
      ["account-onboarding", "Verify the business"],
      ["account-management", "Account"],
      ["payments", "Payments"],
      ["payouts", "Payouts"]
    ];
    parts.forEach(function (part) {
      var section = document.createElement("section");
      if (part[1]) {
        var heading = document.createElement("h3");
        heading.textContent = part[1];
        section.appendChild(heading);
      }
      var element = document.createElement("stripe-connect-" + part[0]);
      if (!element.setConnector) {
        var previous = element.style.display;
        element.style.display = "none";
        document.body.appendChild(element);
        document.body.removeChild(element);
        element.style.display = previous;
      }
      if (typeof element.setConnector !== "function") {
        showError("Stripe could not load " + part[0] + ".");
        return;
      }
      element.setConnector(instance.connect);
      if (part[0] === "account-onboarding" && typeof element.setOnExitInternalOnly === "function") {
        element.setOnExitInternalOnly(function () { window.location.reload(); });
      }
      section.appendChild(element);
      root.appendChild(section);
    });
  };
  script.onerror = function () { showError("Stripe could not load."); };
  document.head.appendChild(script);
})();
`;
