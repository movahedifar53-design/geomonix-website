// GeoMonix AI intake + quote chat widget
// Plain JS, no build step. State machine:
//   intake     → chatting with Claude to extract the brief
//   contact    → mini-form collecting name + email
//   generating → awaiting /api/quote
//   card       → quote preview shown in chat (safe services)
//   holding    → "we'll email you within 24h" shown in chat (review services)

(function () {
    "use strict";

    // ────────── Configuration ──────────
    // Replaced at runtime via globals set in index.html.
    const INTAKE_ENDPOINT = window.GM_INTAKE_ENDPOINT || "https://geomonix-intake.<your-subdomain>.workers.dev/api/intake";
    const QUOTE_ENDPOINT  = (window.GM_INTAKE_ENDPOINT || "").replace(/\/api\/intake$/, "/api/quote")
                          || "https://geomonix-intake.<your-subdomain>.workers.dev/api/quote";
    const TURNSTILE_SITE_KEY = window.GM_TURNSTILE_SITE_KEY || "";

    // ────────── State ──────────
    const state = {
        open: false,
        sending: false,
        stage: "intake",          // intake | contact | generating | card | holding
        messages: [],             // chat history (role/content)
        brief: null,              // set when intake completes
        turnstileToken: "",
        turnstileWidgetId: null,
        turnstileResolver: null,  // Promise resolver waiting for a fresh token
    };

    // ────────── DOM helper ──────────
    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "class") node.className = v;
            else if (k === "html") node.innerHTML = v;
            else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const child of [].concat(children)) {
            if (child == null) continue;
            node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
        }
        return node;
    }

    // ────────── DOM refs ──────────
    let root, bodyEl, inputEl, sendBtn, footerEl, turnstileContainer;

    function buildChatDom() {
        bodyEl = el("div", { class: "gm-chat__body" });

        inputEl = el("textarea", {
            class: "gm-chat__input",
            placeholder: "Type your reply...",
            rows: "1",
        });
        inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendUserMessage(); }
        });
        inputEl.addEventListener("input", () => {
            inputEl.style.height = "auto";
            inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
        });

        sendBtn = el("button", { class: "gm-chat__send", type: "button", onclick: sendUserMessage }, "Send");
        footerEl = el("div", { class: "gm-chat__footer" }, [inputEl, sendBtn]);

        turnstileContainer = el("div", { class: "gm-chat__turnstile", id: "gm-turnstile-container" });

        const chat = el("div", { class: "gm-chat", role: "dialog", "aria-label": "Project intake assistant" }, [
            el("div", { class: "gm-chat__header" }, [
                el("div", { class: "gm-chat__title" }, [
                    el("strong", {}, "Project intake"),
                    el("span", {}, "AI-assisted \u00b7 reviewed by Dr Movahedifar"),
                ]),
                el("button", { class: "gm-chat__close", type: "button", "aria-label": "Close", onclick: close }, "\u00d7"),
            ]),
            bodyEl,
            turnstileContainer,
            footerEl,
            el("div", { class: "gm-chat__disclaimer" },
                "Conversation used only to prepare your brief. Not engineering advice."),
        ]);

        root = el("div", { class: "gm-chat-backdrop", onclick: (e) => { if (e.target === root) close(); } }, [chat]);
        document.body.appendChild(root);
    }

    // ────────── Render helpers ──────────
    function addMessage(role, content) {
        const cls = role === "user" ? "gm-chat__msg gm-chat__msg--user"
                  : role === "error" ? "gm-chat__msg gm-chat__msg--error"
                  : "gm-chat__msg gm-chat__msg--assistant";
        const node = el("div", { class: cls }, content);
        bodyEl.appendChild(node);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        return node;
    }
    function showTyping() {
        const node = el("div", { class: "gm-chat__typing", id: "gm-typing" }, [
            el("span"), el("span"), el("span"),
        ]);
        bodyEl.appendChild(node);
        bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    function hideTyping() {
        const node = document.getElementById("gm-typing");
        if (node) node.remove();
    }

    // ────────── Turnstile ──────────
    function loadTurnstileIfNeeded() {
        if (!TURNSTILE_SITE_KEY) return;
        if (window.turnstile) { renderTurnstile(); return; }
        if (document.getElementById("gm-turnstile-script")) return;
        const s = document.createElement("script");
        s.id = "gm-turnstile-script";
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.async = true;
        s.defer = true;
        s.onload = renderTurnstile;
        document.head.appendChild(s);
    }
    function renderTurnstile() {
        if (!window.turnstile || state.turnstileWidgetId !== null) return;
        state.turnstileWidgetId = window.turnstile.render("#gm-turnstile-container", {
            sitekey: TURNSTILE_SITE_KEY,
            theme: "dark",
            size: "flexible",
            callback: (token) => {
                state.turnstileToken = token;
                if (state.turnstileResolver) {
                    const r = state.turnstileResolver;
                    state.turnstileResolver = null;
                    state.turnstileToken = "";
                    r(token);
                }
                if (sendBtn) sendBtn.disabled = false;
            },
            "error-callback":   () => { state.turnstileToken = ""; },
            "expired-callback": () => { state.turnstileToken = ""; },
        });
    }
    // Get a fresh single-use token. Resets the widget to auto-solve again in
    // managed mode; user sees nothing unless Cloudflare decides to challenge.
    function getFreshTurnstileToken() {
        return new Promise((resolve, reject) => {
            if (!TURNSTILE_SITE_KEY) { resolve(""); return; }
            if (state.turnstileToken) {
                const t = state.turnstileToken;
                state.turnstileToken = "";
                resolve(t);
                return;
            }
            if (!window.turnstile || state.turnstileWidgetId === null) {
                reject(new Error("turnstile not ready"));
                return;
            }
            state.turnstileResolver = resolve;
            try { window.turnstile.reset(state.turnstileWidgetId); }
            catch (e) { reject(e); }
            // Hard timeout so we don't hang forever.
            setTimeout(() => {
                if (state.turnstileResolver === resolve) {
                    state.turnstileResolver = null;
                    reject(new Error("turnstile timeout"));
                }
            }, 15000);
        });
    }

    // ────────── Intake flow ──────────
    async function sendUserMessage() {
        if (state.stage !== "intake") return;
        const text = inputEl.value.trim();
        if (!text || state.sending) return;

        const isFirst = state.messages.length === 0;
        if (isFirst && TURNSTILE_SITE_KEY && !state.turnstileToken) {
            addMessage("error", "Please complete the verification above first.");
            return;
        }

        inputEl.value = "";
        inputEl.style.height = "auto";
        state.messages.push({ role: "user", content: text });
        addMessage("user", text);

        state.sending = true;
        sendBtn.disabled = true;
        showTyping();

        try {
            const turnstileToken = isFirst ? state.turnstileToken : undefined;
            if (isFirst) state.turnstileToken = "";

            const res = await fetch(INTAKE_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: state.messages, turnstileToken }),
            });
            hideTyping();

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                addMessage("error", err.error || `Request failed (${res.status}).`);
                return;
            }
            const data = await res.json();

            state.messages.push({
                role: "assistant",
                content: JSON.stringify({ message: data.message, done: data.done, brief: data.brief || null }),
            });
            addMessage("assistant", data.message);

            if (data.done && data.brief) {
                state.brief = data.brief;
                setTimeout(() => enterContactStage(), 500);
            }
        } catch (e) {
            hideTyping();
            addMessage("error", "Network error \u2014 please try again, or use the form below.");
        } finally {
            state.sending = false;
            sendBtn.disabled = false;
            if (inputEl) inputEl.focus();
        }
    }

    // ────────── Contact capture stage ──────────
    function enterContactStage() {
        state.stage = "contact";
        footerEl.style.display = "none";

        const nameInput  = el("input", { type: "text",  class: "gm-chat__field", placeholder: "Full name",     required: "required" });
        const emailInput = el("input", { type: "email", class: "gm-chat__field", placeholder: "you@example.com", required: "required" });
        const submitBtn  = el("button", { type: "submit", class: "gm-chat__send gm-chat__send--wide" }, "Prepare my quote");

        const form = el("form", {
            class: "gm-chat__miniform",
            onsubmit: (e) => {
                e.preventDefault();
                const name  = nameInput.value.trim();
                const email = emailInput.value.trim();
                if (name.length < 2) { nameInput.focus(); return; }
                if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { emailInput.focus(); return; }
                submitBtn.disabled = true;
                submitBtn.textContent = "Preparing...";
                requestQuote({ name, email });
            },
        }, [
            el("p", { class: "gm-chat__miniform-intro" },
                "Great \u2014 one last step. Enter your name and email and I'll prepare an indicative quote for you."),
            nameInput,
            emailInput,
            el("p", { class: "gm-chat__miniform-consent" },
                "By continuing you agree we may contact you about your enquiry. We do not share your details."),
            submitBtn,
        ]);

        bodyEl.appendChild(form);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        setTimeout(() => nameInput.focus(), 100);
    }

    // ────────── Quote request ──────────
    function buildTranscript() {
        const lines = [];
        for (const m of state.messages) {
            if (m.role === "user") {
                lines.push(`CLIENT: ${m.content}`);
            } else {
                try {
                    const parsed = JSON.parse(m.content);
                    lines.push(`ASSISTANT: ${parsed.message || m.content}`);
                } catch {
                    lines.push(`ASSISTANT: ${m.content}`);
                }
            }
        }
        return lines.join("\n");
    }

    async function requestQuote(client) {
        state.stage = "generating";
        // Remove mini-form, show generating state.
        const miniform = bodyEl.querySelector(".gm-chat__miniform");
        if (miniform) miniform.remove();

        const loading = el("div", { class: "gm-chat__generating" }, [
            el("div", { class: "gm-chat__spinner" }),
            el("p", {}, "Preparing your quote \u2014 this takes 10-20 seconds."),
            el("p", { class: "gm-chat__generating-sub" },
                "Writing a preview sample and estimating an indicative price range."),
        ]);
        bodyEl.appendChild(loading);
        bodyEl.scrollTop = bodyEl.scrollHeight;

        let turnstileToken = "";
        try {
            turnstileToken = await getFreshTurnstileToken();
        } catch (e) {
            // If Turnstile fails we'll let the server-side check return an error.
        }

        try {
            const res = await fetch(QUOTE_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    brief: state.brief,
                    client,
                    transcript: buildTranscript(),
                    turnstileToken,
                }),
            });
            loading.remove();

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                addMessage("error",
                    (err.error || "Quote generation failed") +
                    " \u2014 please use the contact form below as a fallback.");
                offerFormFallback(client);
                return;
            }
            const data = await res.json();

            if (data.kind === "card") {
                renderQuoteCard(data, client);
            } else if (data.kind === "holding") {
                renderHolding(data, client);
            } else {
                addMessage("error", "Unexpected response \u2014 please try the contact form below.");
                offerFormFallback(client);
            }
        } catch (e) {
            loading.remove();
            addMessage("error", "Network error \u2014 please try the contact form below.");
            offerFormFallback(client);
        }
    }

    // ────────── Quote card (safe services) ──────────
    function renderQuoteCard(data, client) {
        state.stage = "card";
        const q = data.quote || {};
        const scopeList = Array.isArray(q.scopeSummary) ? q.scopeSummary : [];

        const card = el("div", { class: "gm-quote-card" }, [
            el("div", { class: "gm-quote-card__header" }, [
                el("span", { class: "gm-quote-card__badge" }, "Indicative quote"),
                el("h3", {}, data.serviceLabel || "Your project"),
            ]),
            el("div", { class: "gm-quote-card__price" }, [
                el("div", { class: "gm-quote-card__range" }, q.priceRange || ""),
                el("div", { class: "gm-quote-card__price-notes" }, q.priceNotes || ""),
            ]),
            scopeList.length
                ? el("div", { class: "gm-quote-card__scope" }, [
                    el("h4", {}, "What a full engagement delivers"),
                    el("ul", {}, scopeList.map((s) => el("li", {}, s))),
                  ])
                : null,
            q.sample ? el("div", { class: "gm-quote-card__sample" }, [
                el("h4", {}, "Preview"),
                el("div", { class: "gm-quote-card__sample-body" }, q.sample),
            ]) : null,
            el("p", { class: "gm-quote-card__disclaimer" }, q.disclaimer || ""),
            el("button", {
                type: "button",
                class: "gm-quote-card__cta",
                onclick: () => bookEngagement(data, client),
            }, "Book this engagement \u2192"),
        ]);

        bodyEl.appendChild(card);
        bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    // ────────── Holding message (review services) ──────────
    function renderHolding(data, client) {
        state.stage = "holding";
        const card = el("div", { class: "gm-quote-card gm-quote-card--holding" }, [
            el("div", { class: "gm-quote-card__header" }, [
                el("span", { class: "gm-quote-card__badge gm-quote-card__badge--review" }, "Under personal review"),
                el("h3", {}, data.serviceLabel || "Your project"),
            ]),
            el("p", { class: "gm-quote-card__holding-msg" }, data.message ||
                "Thank you. Dr Movahedifar will review your brief and respond within 24 hours."),
            el("p", { class: "gm-quote-card__holding-sub" },
                "We've sent a confirmation to " + client.email + ". Reply to it any time to add details."),
            el("button", {
                type: "button",
                class: "gm-quote-card__cta gm-quote-card__cta--secondary",
                onclick: close,
            }, "Close"),
        ]);
        bodyEl.appendChild(card);
        bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    // ────────── Book engagement = pre-fill Formspree form and close ──────────
    function bookEngagement(data, client) {
        const form = document.getElementById("contactForm");
        if (!form) { close(); return; }
        const nameField    = form.querySelector('input[name="name"]');
        const emailField   = form.querySelector('input[name="email"]');
        const serviceField = form.querySelector('select[name="service"]');
        const messageField = form.querySelector('textarea[name="message"]');

        if (nameField)  nameField.value  = client.name;
        if (emailField) emailField.value = client.email;
        if (serviceField && data.service) {
            const opt = Array.from(serviceField.options).find((o) => o.value === data.service);
            if (opt) serviceField.value = data.service;
        }
        if (messageField) {
            const q = data.quote || {};
            const briefSummary = state.brief ? state.brief.summary : "";
            messageField.value =
                `BRIEF\n${briefSummary}\n\n` +
                `INDICATIVE QUOTE (AI preview)\n${q.priceRange || ""}\n\n` +
                `The client saw a preview sample of the deliverable in the chat widget and clicked Book.`;
            messageField.dispatchEvent(new Event("input", { bubbles: true }));
        }

        close();
        const contactSection = document.getElementById("contact");
        if (contactSection) contactSection.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => {
            const submit = form.querySelector('button[type="submit"]');
            if (submit) submit.focus();
        }, 600);
    }

    // ────────── Fallback: just pre-fill the form, no quote ──────────
    function offerFormFallback(client) {
        const fallback = el("button", {
            type: "button",
            class: "gm-quote-card__cta gm-quote-card__cta--secondary",
            onclick: () => {
                const form = document.getElementById("contactForm");
                if (form) {
                    const nameField  = form.querySelector('input[name="name"]');
                    const emailField = form.querySelector('input[name="email"]');
                    const messageField = form.querySelector('textarea[name="message"]');
                    if (nameField)  nameField.value  = client.name;
                    if (emailField) emailField.value = client.email;
                    if (messageField && state.brief) messageField.value = state.brief.summary;
                }
                close();
                const contactSection = document.getElementById("contact");
                if (contactSection) contactSection.scrollIntoView({ behavior: "smooth", block: "start" });
            },
        }, "Use contact form instead");
        bodyEl.appendChild(fallback);
    }

    // ────────── Open / close ──────────
    function open() {
        if (!root) buildChatDom();
        state.open = true;
        root.classList.add("gm-open");
        document.body.style.overflow = "hidden";
        if (state.messages.length === 0) {
            addMessage("assistant",
                "Hello. I'm here to help you describe your project so Dr Movahedifar can reply with a useful next step. " +
                "In one sentence \u2014 what do you need help with?");
            loadTurnstileIfNeeded();
        }
        setTimeout(() => inputEl && inputEl.focus(), 100);
    }
    function close() {
        if (!root) return;
        state.open = false;
        root.classList.remove("gm-open");
        document.body.style.overflow = "";
    }

    // ────────── CTA button injection ──────────
    function injectCta() {
        const form = document.getElementById("contactForm");
        if (!form || document.querySelector(".gm-intake-cta")) return;
        const btn = el("button", { type: "button", class: "gm-intake-cta", onclick: open }, [
            el("span", { class: "gm-intake-cta__icon", html:
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
            }),
            el("span", { class: "gm-intake-cta__text" }, [
                el("strong", {}, "Get an instant indicative quote"),
                el("span", {}, "Describe your project \u00b7 see a preview sample and price range"),
            ]),
            el("span", { class: "gm-intake-cta__arrow", html:
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
            }),
        ]);
        form.parentNode.insertBefore(btn, form);
    }

    // ────────── Boot ──────────
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", injectCta);
    } else {
        injectCta();
    }

    // Escape to close
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && state.open) close();
    });
})();
