export const SUPPORTED_GIG_PLATFORMS = Object.freeze([
  "Uber", "Lyft", "DoorDash", "Spark", "Amazon Flex", "Roadie",
  "Instacart", "Shipt", "Grubhub", "Veho",
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function evaluateGigOffer(input = {}) {
  const pay = finite(input.pay);
  const miles = finite(input.miles);
  const minutes = finite(input.minutes);
  const pickupMiles = finite(input.pickupMiles) ?? 0;
  const returnTripRisk = Math.max(0, Math.min(1, finite(input.returnTripRisk) ?? 0));
  const costPerMile = finite(input.costPerMile) ?? 0.35;
  const minimumDollarsPerMile = finite(input.minimumDollarsPerMile) ?? 1.5;
  const minimumHourlyRate = finite(input.minimumHourlyRate) ?? 20;
  const missingInputs = [];
  if (pay === null) missingInputs.push("pay");
  if (miles === null || miles === 0) missingInputs.push("miles");
  if (minutes === null || minutes === 0) missingInputs.push("minutes");

  const totalMiles = miles === null ? null : miles + pickupMiles;
  const dollarsPerMile = pay !== null && totalMiles ? pay / totalMiles : null;
  const dollarsPerHour = pay !== null && minutes ? (pay / minutes) * 60 : null;
  const deadMiles = pickupMiles;
  const estimatedCosts = totalMiles === null ? null : totalMiles * costPerMile;
  const netEstimate = pay !== null && estimatedCosts !== null ? pay - estimatedCosts : null;
  let score = 50;
  if (dollarsPerMile !== null) score += (dollarsPerMile - minimumDollarsPerMile) * 22;
  if (dollarsPerHour !== null) score += ((dollarsPerHour - minimumHourlyRate) / 5) * 9;
  score -= deadMiles * 1.5;
  score -= returnTripRisk * 12;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const confidence = missingInputs.length ? 0.45 : 0.82;
  const decision = missingInputs.length ? "review" : score >= 68 ? "accept" : score <= 42 ? "decline" : "review";

  return {
    score,
    recommendationScore: score,
    decision,
    dollarsPerMile: dollarsPerMile === null ? null : Number(dollarsPerMile.toFixed(2)),
    dollarsPerHour: dollarsPerHour === null ? null : Number(dollarsPerHour.toFixed(2)),
    deadMiles: Number(deadMiles.toFixed(2)),
    estimatedCosts: estimatedCosts === null ? null : Number(estimatedCosts.toFixed(2)),
    netEstimate: netEstimate === null ? null : Number(netEstimate.toFixed(2)),
    destinationQuality: input.destinationQuality || "unknown",
    nextOpportunity: input.nextOpportunity || "unknown",
    keyReasons: [
      dollarsPerMile === null ? null : `$${dollarsPerMile.toFixed(2)} per total mile`,
      dollarsPerHour === null ? null : `$${dollarsPerHour.toFixed(2)} gross per hour`,
      deadMiles > 0 ? `${deadMiles.toFixed(1)} pickup/dead miles` : null,
    ].filter(Boolean),
    risks: [
      ...missingInputs.map((name) => `Missing ${name}`),
      returnTripRisk > 0 ? "Return-trip demand is uncertain" : null,
    ].filter(Boolean),
    missingInputs,
    confidence,
    methodology: "Explainable estimate, not a guarantee or platform rule.",
  };
}

export function driverIntelligencePrompt(state = {}) {
  return [
    "DRIVER INTELLIGENCE",
    `Supported configured platforms: ${SUPPORTED_GIG_PLATFORMS.join(", ")}.`,
    "Reason with pay per mile, pay per minute/hour, pickup and dead miles, wait time, traffic, tolls, parking, destination quality, return-trip risk, safety, weather, event windows, and next-order probability only when data exists.",
    "Never invent surge, exact attendance, demand, closing time, earnings, traffic, platform policy, or an event end time.",
    "Separate verified facts from estimates and recommendations. State missing information.",
    "For event driving strategy, use the verified start time and venue. If no official end time exists, label any duration or exit window as an estimate.",
    "Use Recomendación, Hora/Zona, Razones, Riesgos, Plan alternativo, Confianza, and Fuentes when useful.",
    "For a daily earnings goal, provide an estimated plan and alternative; never promise the target.",
    `Active driver goal: ${state.activeDriverGoal || state.activeGoal || "none"}.`,
  ].join("\n");
}
