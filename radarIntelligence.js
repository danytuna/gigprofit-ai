const DAY_FACTORS = Object.freeze({
  Monday: 0.93,
  Tuesday: 0.95,
  Wednesday: 0.98,
  Thursday: 1.02,
  Friday: 1.12,
  Saturday: 1.15,
  Sunday: 0.98,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function parseExpectedRange(text) {
  const matches = String(text || "").match(/\$?([0-9]+(?:\.[0-9]+)?)\s*[-–]\s*\$?([0-9]+(?:\.[0-9]+)?)/);
  if (!matches) return { low: 18, high: 28, midpoint: 23 };
  const low = Number(matches[1]);
  const high = Number(matches[2]);
  return {
    low,
    high,
    midpoint: (low + high) / 2,
  };
}

export function timeDemandProfile({ zoneType = "", hour = 12, dayOfWeek = "Monday" } = {}) {
  const type = String(zoneType).toLowerCase();
  const weekend = dayOfWeek === "Saturday" || dayOfWeek === "Sunday";
  let factor = DAY_FACTORS[dayOfWeek] || 1;
  let scoreBonus = 0;
  let label = "normal";

  if (type.includes("airport")) {
    if ((hour >= 5 && hour <= 9) || (hour >= 16 && hour <= 21)) {
      factor *= 1.12;
      scoreBonus += 8;
      label = "airport peak";
    } else if (hour <= 4) {
      factor *= 0.78;
      scoreBonus -= 9;
      label = "low airport window";
    }
  } else if (type.includes("nightlife") || type.includes("bar")) {
    if (hour >= 20 || hour <= 2) {
      factor *= weekend || dayOfWeek === "Friday" ? 1.22 : 1.12;
      scoreBonus += weekend || dayOfWeek === "Friday" ? 14 : 9;
      label = "nightlife peak";
    } else if (hour >= 11 && hour <= 14) {
      factor *= 0.88;
      scoreBonus -= 4;
      label = "off-peak nightlife";
    }
  } else if (type.includes("downtown") || type.includes("business")) {
    if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19)) {
      factor *= 1.13;
      scoreBonus += 10;
      label = "commute peak";
    } else if (hour >= 11 && hour <= 13) {
      factor *= 1.06;
      scoreBonus += 5;
      label = "lunch activity";
    } else if (hour <= 4) {
      factor *= 0.72;
      scoreBonus -= 12;
      label = "overnight low";
    }
  } else if (type.includes("shopping") || type.includes("retail")) {
    if (hour >= 11 && hour <= 19) {
      factor *= weekend ? 1.13 : 1.05;
      scoreBonus += weekend ? 8 : 4;
      label = "retail activity";
    } else if (hour <= 8 || hour >= 22) {
      factor *= 0.76;
      scoreBonus -= 9;
      label = "retail closed window";
    }
  } else if (type.includes("university") || type.includes("college")) {
    if ((hour >= 11 && hour <= 15) || hour >= 19 || hour <= 1) {
      factor *= weekend ? 1.10 : 1.07;
      scoreBonus += 6;
      label = "campus activity";
    } else if (hour >= 7 && hour <= 10) {
      factor *= 1.04;
      scoreBonus += 3;
      label = "campus commute";
    }
  } else if (type.includes("transit")) {
    if ((hour >= 6 && hour <= 9) || (hour >= 16 && hour <= 20)) {
      factor *= 1.09;
      scoreBonus += 7;
      label = "transit peak";
    }
  } else if (type.includes("medical")) {
    if ((hour >= 6 && hour <= 9) || (hour >= 18 && hour <= 22)) {
      factor *= 1.04;
      scoreBonus += 3;
      label = "shift change activity";
    }
  } else if (type.includes("commercial") || type.includes("neighborhood") || type.includes("locality")) {
    if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 20)) {
      factor *= 1.06;
      scoreBonus += 4;
      label = "local commute activity";
    } else if (hour >= 11 && hour <= 14) {
      factor *= 1.04;
      scoreBonus += 3;
      label = "local lunch activity";
    }
  }

  return {
    factor: clamp(factor, 0.6, 1.35),
    scoreBonus: Math.round(scoreBonus),
    label,
  };
}

function localMinutes(localDate, localTime) {
  const match = `${localDate || ""}T${localTime || ""}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ) / 60000;
}

export function eventDemandImpact({ event, zoneLat, zoneLon, nowLocalDate, nowLocalTime, distanceMiles }) {
  if (!event?.date || !event?.time || !Number.isFinite(distanceMiles)) {
    return { scoreBoost: 0, earningsBoost: 0, active: false, reason: null };
  }

  const now = localMinutes(nowLocalDate, nowLocalTime);
  const start = localMinutes(event.date, event.time);
  if (now === null || start === null) {
    return { scoreBoost: 0, earningsBoost: 0, active: false, reason: null };
  }

  const minutesUntilStart = start - now;
  const proximity = distanceMiles < 1.5 ? 1 : distanceMiles < 3 ? 0.72 : distanceMiles < 5 ? 0.45 : 0;
  if (proximity === 0) {
    return { scoreBoost: 0, earningsBoost: 0, active: false, reason: null };
  }

  let phaseWeight = 0;
  let phase = null;
  if (minutesUntilStart >= 0 && minutesUntilStart <= 180) {
    phaseWeight = minutesUntilStart <= 75 ? 1 : 0.65;
    phase = "pre-event arrival window";
  } else if (minutesUntilStart < 0 && minutesUntilStart >= -240) {
    // Ticketmaster generally does not provide an official end time. Keep this
    // conservative and label it as possible post-start activity.
    phaseWeight = minutesUntilStart >= -120 ? 0.55 : 0.35;
    phase = "possible event activity window";
  }

  if (!phaseWeight) {
    return { scoreBoost: 0, earningsBoost: 0, active: false, reason: null };
  }

  const scoreBoost = Math.round(8 * proximity * phaseWeight);
  const earningsBoost = Number((2.5 * proximity * phaseWeight).toFixed(1));
  return {
    scoreBoost,
    earningsBoost,
    active: scoreBoost > 0,
    reason: `${event.name || "Nearby event"}: ${phase}`,
    minutesUntilStart,
  };
}

export function buildRadarMarketEstimate({
  baseExpectedText,
  community = {},
  trafficLevel = "unknown",
  timeProfile,
  totalEventEarningsBoost = 0,
  zoneType = "",
  activityEvidence = 0,
} = {}) {
  const base = parseExpectedRange(baseExpectedText);
  const zoneCount = Number(community.zoneCount || 0);
  const cityCount = Number(community.cityCount || 0);
  let center = base.midpoint;
  let source = "historical-market-model";
  let sampleCount = 0;

  if (Number.isFinite(community.zoneAvgHourly) && zoneCount >= 3) {
    center = Number(community.zoneAvgHourly);
    source = "recent-zone-reports";
    sampleCount = zoneCount;
  } else if (Number.isFinite(community.cityAvgHourly) && cityCount >= 6) {
    center = Number(community.cityAvgHourly);
    source = "recent-city-reports";
    sampleCount = cityCount;
  } else if (Number.isFinite(community.zoneAvgHourly)) {
    center = base.midpoint * 0.72 + Number(community.zoneAvgHourly) * 0.28;
    source = "blended-zone-model";
    sampleCount = zoneCount;
  } else if (Number.isFinite(community.cityAvgHourly)) {
    center = base.midpoint * 0.84 + Number(community.cityAvgHourly) * 0.16;
    source = "blended-city-model";
    sampleCount = cityCount;
  }

  center *= Number(timeProfile?.factor || 1);

  // Area density is a modest signal. It differentiates active districts without
  // pretending that POI density equals live demand or surge.
  center *= 1 + clamp(Number(activityEvidence || 0), 0, 10) * 0.006;

  const trafficFactor = {
    light: 1.01,
    moderate: 0.97,
    busy: 0.90,
    heavy: 0.82,
  }[trafficLevel] || 1;
  center *= trafficFactor;

  // Events help, but never turn a weak market estimate into an unrealistic one.
  center += clamp(Number(totalEventEarningsBoost || 0), 0, 4);

  const type = String(zoneType).toLowerCase();
  if (type.includes("airport")) center *= 1.02;
  if (type.includes("nightlife") && (timeProfile?.label || "").includes("peak")) center *= 1.03;
  if (type.includes("retail") && (timeProfile?.label || "").includes("closed")) center *= 0.92;

  const lowConfidence = sampleCount < 3;
  center = clamp(center, 12, lowConfidence ? 42 : 60);

  const spread =
    sampleCount >= 10 ? 0.12 :
    sampleCount >= 5 ? 0.16 :
    sampleCount >= 3 ? 0.20 :
    0.30;

  const low = clamp(center * (1 - spread / 2), 10, 55);
  const high = clamp(center * (1 + spread / 2), 12, 65);
  const confidence =
    sampleCount >= 10 ? "high" :
    sampleCount >= 3 ? "medium" :
    "low";

  return {
    expected: `$${Math.round(low)}-$${Math.round(high)}/hr`,
    expectedLow: Number(low.toFixed(1)),
    expectedHigh: Number(high.toFixed(1)),
    expectedSource: source,
    expectedSampleCount: sampleCount,
    confidence,
    isEstimate: true,
  };
}

export function evidenceAdjustedRadarScore({
  baseScore,
  timeBonus = 0,
  eventBoost = 0,
  distancePenalty = 0,
  trafficPenalty = 0,
  community = {},
  liveTraffic = false,
  activityEvidence = 0,
  zoneConfidence = "low",
} = {}) {
  const zoneCount = Number(community.zoneCount || 0);
  const cityCount = Number(community.cityCount || 0);

  let evidenceBonus = 0;
  if (zoneCount >= 10) evidenceBonus = 10;
  else if (zoneCount >= 5) evidenceBonus = 7;
  else if (zoneCount >= 3) evidenceBonus = 4;
  else if (cityCount >= 10) evidenceBonus = 3;

  const areaBonus = clamp(Number(activityEvidence || 0), 0, 10);
  const raw =
    Number(baseScore || 0) +
    Number(timeBonus || 0) +
    Math.min(Number(eventBoost || 0), 8) +
    evidenceBonus +
    areaBonus -
    Number(distancePenalty || 0) -
    Number(trafficPenalty || 0);

  let evidenceCap = zoneConfidence === "high" ? 91 : zoneConfidence === "medium" ? 89 : 86;
  if (zoneCount >= 10) evidenceCap = 98;
  else if (zoneCount >= 3) evidenceCap = 94;
  else if (cityCount >= 10) evidenceCap = 92;
  else if (liveTraffic && (Number(eventBoost || 0) > 0 || areaBonus >= 6)) evidenceCap = Math.max(evidenceCap, 91);

  return Math.round(clamp(raw, 1, evidenceCap));
}

export function clampRadarScore(value) {
  return Math.round(clamp(Number(value || 0), 1, 100));
}
