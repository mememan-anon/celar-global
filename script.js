const stepIndicator = document.querySelector("#step-indicator");
const nextStepButton = document.querySelector("#next-step");
const backStepButton = document.querySelector("#back-step");
const stepOneForm = document.querySelector("#step-one-form");
const stepTwoForm = document.querySelector("#step-two-form");
const stages = Array.from(document.querySelectorAll(".form-stage"));
const personaSelect = document.querySelector("#persona");
const personaOtherField = document.querySelector("#persona-other-field");
const personaOtherInput = document.querySelector("#persona-other");
const emailInput = document.querySelector("#email");
const useCaseInput = document.querySelector("#use-case");
const feedback = document.querySelector("#form-feedback");
const submitButton = stepTwoForm.querySelector('button[type="submit"]');

const successTitle = document.querySelector("#success-title");
const successCopy = document.querySelector("#success-copy");
const successPrimary = document.querySelector("#success-primary");
const successSecondary = document.querySelector("#success-secondary");

const bookingUrl =
  "https://outlook.office.com/bookwithme/user/0e9110bb331c4a8f9f87d31e93814595@celar.io/meetingtype/SDQyazS-9kChn5w49o3l5Q2?anonymous&ep=mlink";

function createSupabaseClient() {
  const config = window.SUPABASE_CONFIG || {};

  if (!config.url || !config.anonKey) {
    return null;
  }

  return window.supabase.createClient(config.url, config.anonKey);
}

const supabaseClient = createSupabaseClient();

function showStage(targetStep) {
  stages.forEach((stage) => {
    const isMatch = stage.dataset.step === String(targetStep);
    stage.classList.toggle("is-active", isMatch);
  });

  if (targetStep === "success") {
    stepIndicator.textContent = "Success";
    return;
  }

  stepIndicator.textContent = `Step ${targetStep} of 2`;
}

function validateForm(form) {
  return form.reportValidity();
}

function focusElementNextFrame(element) {
  if (!element) {
    return;
  }

  window.requestAnimationFrame(() => {
    element.focus();
  });
}

function setFeedback(message = "", state = "error") {
  if (!message) {
    feedback.textContent = "";
    feedback.dataset.state = "";
    feedback.classList.add("hidden");
    return;
  }

  feedback.textContent = message;
  feedback.dataset.state = state;
  feedback.classList.remove("hidden");
}

function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
  submitButton.textContent = isSubmitting ? "Saving..." : "Join waitlist";
}

function syncPersonaOtherField() {
  const isOther = personaSelect.value === "other";

  personaOtherField.classList.toggle("hidden", !isOther);
  personaOtherInput.required = isOther;

  if (!isOther) {
    personaOtherInput.value = "";
  }
}

function getLeadScore({ persona, volume, useCase }) {
  let score = 0;

  if (persona === "business") score += 25;
  if (persona === "marketplace") score += 35;
  if (volume === "10k-100k") score += 25;
  if (volume === "100k+") score += 50;
  if (useCase.length >= 80) score += 10;

  return score;
}

function applySuccessState(isQualifiedLead) {
  successTitle.textContent = "You're on the waitlist";

  if (isQualifiedLead) {
    successCopy.textContent =
      "Thanks for sharing your setup. You look like a strong fit for early access, so if you want to help shape the product, talk to us.";
    successPrimary.textContent = "Talk to us";
    successPrimary.setAttribute("href", bookingUrl);
    successPrimary.setAttribute("target", "_blank");
    successPrimary.setAttribute("rel", "noreferrer");
    successSecondary.classList.remove("hidden");
    successSecondary.setAttribute("href", "#how-it-works");
    successSecondary.removeAttribute("target");
    successSecondary.removeAttribute("rel");
    successSecondary.textContent = "See how it works";
    return;
  }

  successCopy.textContent =
    "We'll be in touch as we review early users and learn where demand is strongest.";
  successPrimary.textContent = "See how it works";
  successPrimary.setAttribute("href", "#how-it-works");
  successPrimary.removeAttribute("target");
  successPrimary.removeAttribute("rel");
  successSecondary.classList.add("hidden");
  successSecondary.setAttribute("href", "#book-call");
  successSecondary.removeAttribute("target");
  successSecondary.removeAttribute("rel");
  successSecondary.textContent = "Book a call";
}

personaSelect.addEventListener("change", syncPersonaOtherField);
syncPersonaOtherField();

nextStepButton.addEventListener("click", () => {
  if (!validateForm(stepOneForm)) {
    return;
  }

  setFeedback();
  showStage(2);
  focusElementNextFrame(useCaseInput);
});

backStepButton.addEventListener("click", () => {
  setFeedback();
  showStage(1);
  focusElementNextFrame(emailInput);
});

stepTwoForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!validateForm(stepTwoForm)) {
    return;
  }

  if (!supabaseClient) {
    setFeedback("Supabase is not configured yet. Add your project URL and anon key in supabase-config.js.");
    return;
  }

  const signupId = window.crypto.randomUUID();
  const persona = personaSelect.value;
  const volume = document.querySelector("#volume").value;
  const useCase = document.querySelector("#use-case").value.trim();
  const email = document.querySelector("#email").value.trim().toLowerCase();
  const needSelect = document.querySelector("#need");
  const need = needSelect.selectedOptions[0]?.textContent.trim() || needSelect.value;
  const corridor = document.querySelector("#corridor").value.trim();
  const personaOther = personaOtherInput.value.trim();

  const isQualifiedLead =
    (persona === "individual" ||
      persona === "business" ||
      persona === "marketplace") &&
    volume === "100k+";

  const payload = {
    id: signupId,
    email,
    persona,
    persona_other: personaOther || null,
    first_use_case: need,
    use_case: useCase,
    monthly_volume: volume,
    market_context: corridor,
    lead_status: isQualifiedLead ? "qualified" : "new",
    lead_score: getLeadScore({ persona, volume, useCase }),
    qualified_for_call: isQualifiedLead
  };

  setFeedback();
  setSubmitting(true);

  const { error } = await supabaseClient.from("waitlist_signups").insert([payload]);

  setSubmitting(false);

  if (error) {
    console.error(error);
    setFeedback("We couldn't save your signup right now. Please try again.");
    return;
  }

  supabaseClient.functions
    .invoke("clever-task", {
      body: { signup_id: signupId }
    })
    .then(({ error: trackingError }) => {
      if (trackingError) {
        console.error("Edge tracking failed", trackingError);
      }
    })
    .catch((trackingError) => {
      console.error("Edge tracking failed", trackingError);
    });

  applySuccessState(isQualifiedLead);
  showStage("success");
});
