/* ═══════════════════════════════════════════════════════════════════════════
   Lumière — Morphing Lamp Controller
   GSAP ScrollTrigger drives the lamp through 5 states along a curved path.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  gsap.registerPlugin(ScrollTrigger);

  // ── References ───────────────────────────────────────────────────────────
  const lamp       = document.getElementById("lamp");
  const brandLogo  = document.getElementById("brand-logo");
  const rail       = document.querySelector(".portfolio-track__rail");
  const sections   = gsap.utils.toArray(".section");

  // ── Helpers ──────────────────────────────────────────────────────────────
  const STATES = ["ceiling", "wall", "spotlight", "table", "lantern"];

  function setLampState(stateName) {
    STATES.forEach(s => lamp.classList.remove("lamp--" + s));
    lamp.classList.add("lamp--" + stateName);
  }

  // ── Section 1: Hover-to-ignite ───────────────────────────────────────────
  // Lamp starts dim. On hover → flash then warm glow; brand logo scales up.
  let isIgnited = false;
  const fixture = lamp.querySelector(".lamp__fixture");

  fixture.addEventListener("mouseenter", () => {
    if (isIgnited) return;
    isIgnited = true;
    // Flash
    gsap.to(lamp.querySelector(".lamp__bulb"), {
      filter: "brightness(2.5)",
      duration: 0.12,
      yoyo: true,
      repeat: 1,
      onComplete() {
        lamp.classList.add("lamp--on");
        brandLogo.classList.add("is-visible");
      }
    });
  });


  // ── Master scroll timeline ─────────────────────────────────────────────
  // We build one continuous GSAP timeline scrubbed to the full page scroll.
  // Each section transition animates:
  //   1. lamp position (top, left)
  //   2. lamp class (shape morph)
  //   3. wire height
  //   4. any section-specific effects

  const totalHeight = () => document.body.scrollHeight - window.innerHeight;

  // We use individual ScrollTriggers per section transition for clarity
  // and so each one gets `scrub: 1.5` for that heavy, inertial feel.

  // ─── Transition: Section 1 → Section 2 ────────────────────────────────
  // Ceiling bulb (top-left) → Wall lamp (middle-left, flush to edge)
  gsap.timeline({
    scrollTrigger: {
      trigger: "#s2",
      start: "top 80%",
      end: "top 20%",
      scrub: 1.5,
      onEnter: () => { setLampState("wall"); lamp.classList.add("lamp--on"); },
      onLeaveBack: () => { setLampState("ceiling"); }
    }
  })
  .to(lamp, {
    top: "50vh",
    left: "0px",
    ease: "power2.inOut"
  }, 0)
  .to(lamp.querySelector(".lamp__wire"), {
    height: 0,
    ease: "power2.inOut"
  }, 0);

  // ─── Transition: Section 2 → Section 3 ────────────────────────────────
  // Wall lamp (left edge) → Spotlight (dead center top, long wire)
  gsap.timeline({
    scrollTrigger: {
      trigger: "#s3",
      start: "top 80%",
      end: "top 20%",
      scrub: 1.5,
      onEnter: () => { setLampState("spotlight"); },
      onLeaveBack: () => { setLampState("wall"); }
    }
  })
  .to(lamp, {
    top: "2vh",
    left: "50vw",
    xPercent: -50,
    ease: "power3.inOut"
  }, 0)
  .to(lamp.querySelector(".lamp__wire"), {
    height: 160,
    ease: "power2.out"
  }, 0);

  // ─── Transition: Section 3 → Section 4 ────────────────────────────────
  // Spotlight (center) → Table lamp (right side, grounded)
  gsap.timeline({
    scrollTrigger: {
      trigger: "#s4",
      start: "top 80%",
      end: "top 20%",
      scrub: 1.5,
      onEnter: () => { setLampState("table"); },
      onLeaveBack: () => { setLampState("spotlight"); }
    }
  })
  .to(lamp, {
    top: "38vh",
    left: "78vw",
    xPercent: 0,
    ease: "power2.inOut"
  }, 0)
  .to(lamp.querySelector(".lamp__wire"), {
    height: 0,
    ease: "power2.inOut"
  }, 0);

  // ─── Transition: Section 4 → Section 5 ────────────────────────────────
  // Table lamp (right) → Lantern (lower-left)
  gsap.timeline({
    scrollTrigger: {
      trigger: "#s5",
      start: "top 80%",
      end: "top 20%",
      scrub: 1.5,
      onEnter: () => { setLampState("lantern"); },
      onLeaveBack: () => { setLampState("table"); }
    }
  })
  .to(lamp, {
    top: "30vh",
    left: "10vw",
    ease: "power3.inOut"
  }, 0)
  .to(lamp.querySelector(".lamp__wire"), {
    height: 20,
    ease: "power2.out"
  }, 0);


  // ── Portfolio rail (Section 4): horizontal scroll driven by vertical ───
  if (rail) {
    gsap.to(rail, {
      x: () => -(rail.scrollWidth - rail.parentElement.clientWidth),
      ease: "none",
      scrollTrigger: {
        trigger: "#s4",
        start: "top top",
        end: "bottom top",
        scrub: 1,
        invalidateOnRefresh: true,
      }
    });
  }

  // ── Section 5 door animation: doors slide open to reveal contact ─────
  const doorLeft  = document.querySelector(".door--left");
  const doorRight = document.querySelector(".door--right");
  const doorLight = document.querySelector(".door-light");
  const doorContact = document.getElementById("door-contact");

  if (doorLeft && doorRight) {
    gsap.timeline({
      scrollTrigger: {
        trigger: "#s5",
        start: "top 80%",
        end: "center center",
        scrub: 1.5,
        onUpdate: (self) => {
          // Reveal contact details once doors are ~30% open
          if (self.progress > 0.3 && doorContact) {
            doorContact.classList.add("is-revealed");
          } else if (doorContact) {
            doorContact.classList.remove("is-revealed");
          }
        }
      }
    })
    // Slide left door to the left, right door to the right
    .to(doorLeft,  { xPercent: -100, ease: "power2.out" }, 0)
    .to(doorRight, { xPercent: 100,  ease: "power2.out" }, 0)
    .to(doorLight, { opacity: 0, width: 0, ease: "power2.out" }, 0);
  }

  // ── Ambient: auto-ignite the lamp if user scrolls past section 1 ───────
  // (In case they never hover, we still want the rest of the journey lit.)
  ScrollTrigger.create({
    trigger: "#s2",
    start: "top 90%",
    once: true,
    onEnter() {
      if (!isIgnited) {
        isIgnited = true;
        lamp.classList.add("lamp--on");
        brandLogo.classList.add("is-visible");
      }
    }
  });

  // ── Subtle pendulum swing on the ceiling bulb (Section 1 idle) ─────────
  const pendulum = gsap.timeline({ repeat: -1, yoyo: true, paused: true });
  pendulum.to(lamp, {
    rotation: 2.5,
    duration: 2.4,
    ease: "sine.inOut"
  }).to(lamp, {
    rotation: -2.5,
    duration: 2.4,
    ease: "sine.inOut"
  });

  // Play pendulum only while in section 1
  ScrollTrigger.create({
    trigger: "#s1",
    start: "top top",
    end: "bottom top",
    onEnter: () => pendulum.play(),
    onLeave: () => { pendulum.pause(); gsap.set(lamp, { rotation: 0 }); },
    onEnterBack: () => pendulum.play(),
    onLeaveBack: () => { pendulum.pause(); gsap.set(lamp, { rotation: 0 }); },
  });

})();
