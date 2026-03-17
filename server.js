import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getNearbyEvents(city) {
  const apiKey = process.env.TICKETMASTER_API_KEY;

  if (!apiKey) return [];

  try {
    const url =
      `https://app.ticketmaster.com/discovery/v2/events.json` +
      `?apikey=${apiKey}` +
      `&city=${encodeURIComponent(city)}` +
      `&size=8` +
      `&sort=date,asc`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Ticketmaster request failed: ${response.status}`);
    }

    const data = await response.json();
    const events = data?._embedded?.events || [];

    return events.map((event) => {
      const venue = event?._embedded?.venues?.[0];

      return {
        name: event?.name || "Unknown Event",
        venue: venue?.name || "Unknown Venue",
        lat: venue?.location?.latitude ? parseFloat(venue.location.latitude) : null,
        lon: venue?.location?.longitude ? parseFloat(venue.location.longitude) : null,
        date: event?.dates?.start?.localDate || null,
        time: event?.dates?.start?.localTime || null
      };
    });
  } catch (error) {
    console.error("TICKETMASTER ERROR:", error.message);
    return [];
  }
}

function getCityZones(city) {
  const zoneMap = {
    Charlotte: [
      {
        city: "Charlotte",
        name: "Uptown",
        type: "downtown",
        lat: 35.2271,
        lon: -80.8431,
        baseScore: 84,
        expected: "$24–$36/hr",
        description: "Strong business, hotel, commuter, and event traffic in central Charlotte."
      },
      {
        city: "Charlotte",
        name: "South End",
        type: "nightlife",
        lat: 35.2130,
        lon: -80.8576,
        baseScore: 88,
        expected: "$28–$40/hr",
        description: "One of the best nightlife and restaurant zones in Charlotte, especially evenings."
      },
      {
        city: "Charlotte",
        name: "NoDa",
        type: "nightlife",
        lat: 35.2479,
        lon: -80.8057,
        baseScore: 78,
        expected: "$22–$34/hr",
        description: "Popular arts and bar district with solid evening and weekend demand."
      },
      {
        city: "Charlotte",
        name: "CLT Airport",
        type: "airport",
        lat: 35.2144,
        lon: -80.9473,
        baseScore: 80,
        expected: "$22–$35/hr",
        description: "Strong airport demand during travel peaks and useful for longer rides."
      },
      {
        city: "Charlotte",
        name: "University City",
        type: "university",
        lat: 35.3071,
        lon: -80.7359,
        baseScore: 70,
        expected: "$18–$28/hr",
        description: "Student and campus traffic can create short-trip demand during active hours."
      }
    ],

    Atlanta: [
      {
        city: "Atlanta",
        name: "Midtown",
        type: "downtown",
        lat: 33.7815,
        lon: -84.3880,
        baseScore: 85,
        expected: "$24–$36/hr",
        description: "Dense offices, hotels, nightlife, and event demand throughout the day."
      },
      {
        city: "Atlanta",
        name: "Buckhead",
        type: "nightlife",
        lat: 33.8467,
        lon: -84.3626,
        baseScore: 86,
        expected: "$28–$40/hr",
        description: "Premium dining and nightlife zone with strong evening rides."
      },
      {
        city: "Atlanta",
        name: "Downtown Atlanta",
        type: "downtown",
        lat: 33.7490,
        lon: -84.3880,
        baseScore: 82,
        expected: "$22–$34/hr",
        description: "Convention, hotel, commuter, and stadium-driven ride activity."
      },
      {
        city: "Atlanta",
        name: "ATL Airport",
        type: "airport",
        lat: 33.6407,
        lon: -84.4277,
        baseScore: 87,
        expected: "$24–$38/hr",
        description: "Major airport demand with consistent ride flow and longer trip potential."
      },
      {
        city: "Atlanta",
        name: "Georgia Tech",
        type: "university",
        lat: 33.7756,
        lon: -84.3963,
        baseScore: 69,
        expected: "$18–$28/hr",
        description: "Student demand and short rides around campus during the day."
      }
    ],

    Miami: [
      {
        city: "Miami",
        name: "Brickell",
        type: "downtown",
        lat: 25.7617,
        lon: -80.1918,
        baseScore: 86,
        expected: "$26–$38/hr",
        description: "Strong office, residential tower, and nightlife demand."
      },
      {
        city: "Miami",
        name: "South Beach",
        type: "nightlife",
        lat: 25.7826,
        lon: -80.1341,
        baseScore: 91,
        expected: "$30–$44/hr",
        description: "One of the hottest nightlife and tourist ride zones in Miami."
      },
      {
        city: "Miami",
        name: "Wynwood",
        type: "nightlife",
        lat: 25.8005,
        lon: -80.1990,
        baseScore: 84,
        expected: "$26–$38/hr",
        description: "Restaurants, bars, and event activity make this a strong evening zone."
      },
      {
        city: "Miami",
        name: "MIA Airport",
        type: "airport",
        lat: 25.7959,
        lon: -80.2870,
        baseScore: 82,
        expected: "$22–$36/hr",
        description: "Airport demand can be strong, especially during travel rush windows."
      },
      {
        city: "Miami",
        name: "Coral Gables",
        type: "shopping",
        lat: 25.7215,
        lon: -80.2684,
        baseScore: 71,
        expected: "$18–$29/hr",
        description: "Steady upscale local demand near shopping and dining."
      }
    ],

    Orlando: [
      {
        city: "Orlando",
        name: "Downtown Orlando",
        type: "downtown",
        lat: 28.5383,
        lon: -81.3792,
        baseScore: 80,
        expected: "$22–$33/hr",
        description: "Good central demand with offices, nightlife, and events."
      },
      {
        city: "Orlando",
        name: "International Drive",
        type: "nightlife",
        lat: 28.4489,
        lon: -81.4706,
        baseScore: 86,
        expected: "$26–$38/hr",
        description: "Tourism, hotels, dining, and attractions create strong ride demand."
      },
      {
        city: "Orlando",
        name: "Universal Area",
        type: "shopping",
        lat: 28.4743,
        lon: -81.4678,
        baseScore: 84,
        expected: "$24–$36/hr",
        description: "Theme park and hotel demand can stay active all day."
      },
      {
        city: "Orlando",
        name: "MCO Airport",
        type: "airport",
        lat: 28.4312,
        lon: -81.3081,
        baseScore: 85,
        expected: "$24–$37/hr",
        description: "Airport rides and hotel transfers make this a strong zone."
      },
      {
        city: "Orlando",
        name: "UCF Area",
        type: "university",
        lat: 28.6024,
        lon: -81.2001,
        baseScore: 68,
        expected: "$18–$28/hr",
        description: "Student traffic and short trips around campus."
      }
    ],

    Tampa: [
      {
        city: "Tampa",
        name: "Downtown Tampa",
        type: "downtown",
        lat: 27.9506,
        lon: -82.4572,
        baseScore: 82,
        expected: "$22–$34/hr",
        description: "Good downtown traffic with offices, hotels, and events."
      },
      {
        city: "Tampa",
        name: "Ybor City",
        type: "nightlife",
        lat: 27.9606,
        lon: -82.4374,
        baseScore: 87,
        expected: "$28–$40/hr",
        description: "Strong nightlife demand, especially late evenings and weekends."
      },
      {
        city: "Tampa",
        name: "Tampa Airport",
        type: "airport",
        lat: 27.9755,
        lon: -82.5332,
        baseScore: 83,
        expected: "$22–$35/hr",
        description: "Airport trips can be reliable during travel-heavy periods."
      },
      {
        city: "Tampa",
        name: "Channelside",
        type: "nightlife",
        lat: 27.9427,
        lon: -82.4452,
        baseScore: 79,
        expected: "$22–$34/hr",
        description: "Restaurants, events, and waterfront activity can make this productive."
      },
      {
        city: "Tampa",
        name: "USF Area",
        type: "university",
        lat: 28.0587,
        lon: -82.4139,
        baseScore: 67,
        expected: "$18–$27/hr",
        description: "Student traffic and short rides around campus."
      }
    ],

    Nashville: [
      {
        city: "Nashville",
        name: "Downtown Nashville",
        type: "downtown",
        lat: 36.1627,
        lon: -86.7816,
        baseScore: 84,
        expected: "$24–$35/hr",
        description: "Core central demand with hotels, events, and music venues."
      },
      {
        city: "Nashville",
        name: "Broadway",
        type: "nightlife",
        lat: 36.1592,
        lon: -86.7762,
        baseScore: 92,
        expected: "$30–$45/hr",
        description: "One of the strongest nightlife strips for rides in the city."
      },
      {
        city: "Nashville",
        name: "The Gulch",
        type: "nightlife",
        lat: 36.1533,
        lon: -86.7831,
        baseScore: 80,
        expected: "$24–$34/hr",
        description: "Strong dining and entertainment demand, especially evenings."
      },
      {
        city: "Nashville",
        name: "BNA Airport",
        type: "airport",
        lat: 36.1245,
        lon: -86.6782,
        baseScore: 81,
        expected: "$22–$34/hr",
        description: "Airport traffic with steady ride demand and longer trip potential."
      },
      {
        city: "Nashville",
        name: "Vanderbilt Area",
        type: "university",
        lat: 36.1447,
        lon: -86.8027,
        baseScore: 68,
        expected: "$18–$28/hr",
        description: "Student and medical district traffic can create short efficient rides."
      }
    ],

    Dallas: [
      {
        city: "Dallas",
        name: "Downtown Dallas",
        type: "downtown",
        lat: 32.7767,
        lon: -96.7970,
        baseScore: 83,
        expected: "$22–$34/hr",
        description: "Central business and hotel demand with event support."
      },
      {
        city: "Dallas",
        name: "Uptown Dallas",
        type: "nightlife",
        lat: 32.8025,
        lon: -96.8003,
        baseScore: 87,
        expected: "$28–$40/hr",
        description: "One of the best dining and nightlife zones in Dallas."
      },
      {
        city: "Dallas",
        name: "Deep Ellum",
        type: "nightlife",
        lat: 32.7843,
        lon: -96.7849,
        baseScore: 84,
        expected: "$26–$38/hr",
        description: "Strong bars, concerts, and entertainment demand."
      },
      {
        city: "Dallas",
        name: "DFW Airport",
        type: "airport",
        lat: 32.8998,
        lon: -97.0403,
        baseScore: 85,
        expected: "$24–$37/hr",
        description: "Large airport with strong ride flow during travel windows."
      },
      {
        city: "Dallas",
        name: "SMU Area",
        type: "university",
        lat: 32.8426,
        lon: -96.7849,
        baseScore: 67,
        expected: "$18–$27/hr",
        description: "Campus and student demand with short ride opportunities."
      }
    ],

    Houston: [
      {
        city: "Houston",
        name: "Downtown Houston",
        type: "downtown",
        lat: 29.7604,
        lon: -95.3698,
        baseScore: 82,
        expected: "$22–$34/hr",
        description: "Strong downtown demand with offices, hotels, and event venues."
      },
      {
        city: "Houston",
        name: "Midtown Houston",
        type: "nightlife",
        lat: 29.7395,
        lon: -95.3772,
        baseScore: 86,
        expected: "$26–$39/hr",
        description: "Popular nightlife and dining zone that performs well in evenings."
      },
      {
        city: "Houston",
        name: "The Galleria",
        type: "shopping",
        lat: 29.7397,
        lon: -95.4612,
        baseScore: 78,
        expected: "$20–$31/hr",
        description: "Strong retail, hotel, and business traffic."
      },
      {
        city: "Houston",
        name: "IAH Airport",
        type: "airport",
        lat: 29.9902,
        lon: -95.3368,
        baseScore: 84,
        expected: "$23–$36/hr",
        description: "Large airport with strong ride opportunities during travel peaks."
      },
      {
        city: "Houston",
        name: "Rice Village",
        type: "university",
        lat: 29.7153,
        lon: -95.4140,
        baseScore: 68,
        expected: "$18–$28/hr",
        description: "Good local demand near campus, shopping, and dining."
      }
    ],

    Austin: [
      {
        city: "Austin",
        name: "Downtown Austin",
        type: "downtown",
        lat: 30.2672,
        lon: -97.7431,
        baseScore: 84,
        expected: "$24–$35/hr",
        description: "Strong downtown demand with offices, events, and hotel traffic."
      },
      {
        city: "Austin",
        name: "Sixth Street",
        type: "nightlife",
        lat: 30.2676,
        lon: -97.7363,
        baseScore: 91,
        expected: "$30–$44/hr",
        description: "One of the hottest nightlife corridors for rides in Austin."
      },
      {
        city: "Austin",
        name: "South Congress",
        type: "nightlife",
        lat: 30.2493,
        lon: -97.7495,
        baseScore: 81,
        expected: "$24–$35/hr",
        description: "Dining, shopping, and nightlife create strong local demand."
      },
      {
        city: "Austin",
        name: "AUS Airport",
        type: "airport",
        lat: 30.1975,
        lon: -97.6664,
        baseScore: 82,
        expected: "$22–$34/hr",
        description: "Airport demand with solid travel-driven rides."
      },
      {
        city: "Austin",
        name: "UT Austin",
        type: "university",
        lat: 30.2849,
        lon: -97.7341,
        baseScore: 70,
        expected: "$18–$29/hr",
        description: "Student demand and short trips around campus."
      }
    ],

    Chicago: [
      {
        city: "Chicago",
        name: "The Loop",
        type: "downtown",
        lat: 41.8781,
        lon: -87.6298,
        baseScore: 86,
        expected: "$24–$36/hr",
        description: "Heavy central demand from offices, hotels, and train commuters."
      },
      {
        city: "Chicago",
        name: "River North",
        type: "nightlife",
        lat: 41.8924,
        lon: -87.6340,
        baseScore: 88,
        expected: "$28–$41/hr",
        description: "One of Chicago’s strongest nightlife and restaurant zones."
      },
      {
        city: "Chicago",
        name: "Wrigleyville",
        type: "nightlife",
        lat: 41.9484,
        lon: -87.6553,
        baseScore: 83,
        expected: "$24–$37/hr",
        description: "Can spike around baseball games, bars, and event nights."
      },
      {
        city: "Chicago",
        name: "O'Hare Airport",
        type: "airport",
        lat: 41.9742,
        lon: -87.9073,
        baseScore: 84,
        expected: "$23–$36/hr",
        description: "Large airport with consistent travel-related ride demand."
      },
      {
        city: "Chicago",
        name: "UChicago / Hyde Park",
        type: "university",
        lat: 41.7943,
        lon: -87.5907,
        baseScore: 66,
        expected: "$18–$27/hr",
        description: "Campus and local neighborhood demand with shorter trips."
      }
    ],

    "New York": [
      {
        city: "New York",
        name: "Midtown Manhattan",
        type: "downtown",
        lat: 40.7549,
        lon: -73.9840,
        baseScore: 90,
        expected: "$28–$42/hr",
        description: "Dense hotel, business, tourist, and event activity all day."
      },
      {
        city: "New York",
        name: "Times Square",
        type: "nightlife",
        lat: 40.7580,
        lon: -73.9855,
        baseScore: 89,
        expected: "$30–$44/hr",
        description: "Heavy tourist and nightlife demand, especially evenings."
      },
      {
        city: "New York",
        name: "Lower Manhattan",
        type: "downtown",
        lat: 40.7060,
        lon: -74.0086,
        baseScore: 84,
        expected: "$24–$36/hr",
        description: "Strong commuter, business, and hotel-driven ride demand."
      },
      {
        city: "New York",
        name: "JFK Airport",
        type: "airport",
        lat: 40.6413,
        lon: -73.7781,
        baseScore: 86,
        expected: "$24–$38/hr",
        description: "Major airport zone with strong long-ride potential."
      },
      {
        city: "New York",
        name: "NYU / Greenwich Village",
        type: "university",
        lat: 40.7295,
        lon: -73.9965,
        baseScore: 77,
        expected: "$22–$33/hr",
        description: "Student, nightlife, and local demand create steady trips."
      }
    ],

    "Los Angeles": [
      {
        city: "Los Angeles",
        name: "Downtown LA",
        type: "downtown",
        lat: 34.0522,
        lon: -118.2437,
        baseScore: 84,
        expected: "$22–$34/hr",
        description: "Central business, hotel, and event-driven ride traffic."
      },
      {
        city: "Los Angeles",
        name: "Hollywood",
        type: "nightlife",
        lat: 34.0928,
        lon: -118.3287,
        baseScore: 89,
        expected: "$28–$41/hr",
        description: "Nightlife, tourism, and entertainment make this a strong zone."
      },
      {
        city: "Los Angeles",
        name: "Santa Monica",
        type: "nightlife",
        lat: 34.0195,
        lon: -118.4912,
        baseScore: 82,
        expected: "$24–$35/hr",
        description: "Beach, dining, hotels, and nightlife create good ride demand."
      },
      {
        city: "Los Angeles",
        name: "LAX Airport",
        type: "airport",
        lat: 33.9416,
        lon: -118.4085,
        baseScore: 88,
        expected: "$24–$38/hr",
        description: "One of the strongest airport demand zones in the region."
      },
      {
        city: "Los Angeles",
        name: "USC Area",
        type: "university",
        lat: 34.0224,
        lon: -118.2851,
        baseScore: 68,
        expected: "$18–$28/hr",
        description: "Student and campus traffic can create steady short rides."
      }
    ],

    Phoenix: [
      {
        city: "Phoenix",
        name: "Downtown Phoenix",
        type: "downtown",
        lat: 33.4484,
        lon: -112.0740,
        baseScore: 81,
        expected: "$22–$33/hr",
        description: "Central business and event activity keep rides flowing."
      },
      {
        city: "Phoenix",
        name: "Old Town Scottsdale",
        type: "nightlife",
        lat: 33.4942,
        lon: -111.9261,
        baseScore: 90,
        expected: "$30–$43/hr",
        description: "One of the hottest nightlife destinations in the metro area."
      },
      {
        city: "Phoenix",
        name: "Tempe",
        type: "university",
        lat: 33.4255,
        lon: -111.9400,
        baseScore: 76,
        expected: "$20–$31/hr",
        description: "Student life, bars, and local activity support ride demand."
      },
      {
        city: "Phoenix",
        name: "PHX Airport",
        type: "airport",
        lat: 33.4342,
        lon: -112.0116,
        baseScore: 84,
        expected: "$23–$35/hr",
        description: "Airport rides perform well during travel-heavy windows."
      },
      {
        city: "Phoenix",
        name: "Biltmore",
        type: "shopping",
        lat: 33.5092,
        lon: -112.0275,
        baseScore: 70,
        expected: "$18–$29/hr",
        description: "Steady local demand near hotels, shopping, and business."
      }
    ],

    "Las Vegas": [
      {
        city: "Las Vegas",
        name: "The Strip",
        type: "nightlife",
        lat: 36.1147,
        lon: -115.1728,
        baseScore: 95,
        expected: "$32–$48/hr",
        description: "Top nightlife and tourist ride zone with constant hotel traffic."
      },
      {
        city: "Las Vegas",
        name: "Fremont Street",
        type: "nightlife",
        lat: 36.1700,
        lon: -115.1447,
        baseScore: 88,
        expected: "$28–$42/hr",
        description: "Strong entertainment and nightlife rides, especially evenings."
      },
      {
        city: "Las Vegas",
        name: "Harry Reid Airport",
        type: "airport",
        lat: 36.0840,
        lon: -115.1537,
        baseScore: 86,
        expected: "$24–$38/hr",
        description: "Airport demand is consistently strong with good long-ride potential."
      },
      {
        city: "Las Vegas",
        name: "Convention Center",
        type: "downtown",
        lat: 36.1319,
        lon: -115.1512,
        baseScore: 83,
        expected: "$24–$36/hr",
        description: "Conventions and hotel activity can drive strong ride demand."
      },
      {
        city: "Las Vegas",
        name: "Summerlin",
        type: "shopping",
        lat: 36.1699,
        lon: -115.2910,
        baseScore: 65,
        expected: "$17–$27/hr",
        description: "More residential and spread out, but can support local rides."
      }
    ],

    "San Francisco": [
      {
        city: "San Francisco",
        name: "Financial District",
        type: "downtown",
        lat: 37.7946,
        lon: -122.3999,
        baseScore: 84,
        expected: "$24–$36/hr",
        description: "Strong weekday office and hotel demand in the city core."
      },
      {
        city: "San Francisco",
        name: "SoMa",
        type: "downtown",
        lat: 37.7786,
        lon: -122.4056,
        baseScore: 82,
        expected: "$22–$34/hr",
        description: "Event venues, business density, and nightlife create solid demand."
      },
      {
        city: "San Francisco",
        name: "Mission District",
        type: "nightlife",
        lat: 37.7599,
        lon: -122.4148,
        baseScore: 86,
        expected: "$26–$38/hr",
        description: "Restaurants, bars, and local nightlife make this a strong evening zone."
      },
      {
        city: "San Francisco",
        name: "SFO Airport",
        type: "airport",
        lat: 37.6213,
        lon: -122.3790,
        baseScore: 85,
        expected: "$24–$37/hr",
        description: "Airport rides can be strong during heavy travel windows."
      },
      {
        city: "San Francisco",
        name: "USF / Inner Sunset",
        type: "university",
        lat: 37.7756,
        lon: -122.4507,
        baseScore: 68,
        expected: "$18–$28/hr",
        description: "Campus and neighborhood activity support steady shorter trips."
      }
    ],

    Seattle: [
      {
        city: "Seattle",
        name: "Downtown Seattle",
        type: "downtown",
        lat: 47.6062,
        lon: -122.3321,
        baseScore: 84,
        expected: "$24–$35/hr",
        description: "Strong core demand with hotels, offices, and event traffic."
      },
      {
        city: "Seattle",
        name: "Capitol Hill",
        type: "nightlife",
        lat: 47.6231,
        lon: -122.3191,
        baseScore: 88,
        expected: "$28–$40/hr",
        description: "One of Seattle’s best nightlife and dining zones."
      },
      {
        city: "Seattle",
        name: "Belltown",
        type: "nightlife",
        lat: 47.6145,
        lon: -122.3451,
        baseScore: 82,
        expected: "$24–$35/hr",
        description: "Hotels, bars, and downtown spillover keep rides active."
      },
      {
        city: "Seattle",
        name: "SEA Airport",
        type: "airport",
        lat: 47.4502,
        lon: -122.3088,
        baseScore: 86,
        expected: "$24–$37/hr",
        description: "Airport rides are usually strong during travel peaks."
      },
      {
        city: "Seattle",
        name: "University District",
        type: "university",
        lat: 47.6613,
        lon: -122.3131,
        baseScore: 69,
        expected: "$18–$29/hr",
        description: "Student demand and local trips near campus."
      }
    ]
  };

  return zoneMap[city] || zoneMap["Charlotte"];
}

function timeBonus(type, hour) {
  switch (type) {
    case "nightlife":
      return hour >= 19 || hour <= 2 ? 12 : 0;
    case "downtown":
      return (hour >= 7 && hour <= 10) || (hour >= 16 && hour <= 19) ? 10 : 3;
    case "airport":
      return (hour >= 5 && hour <= 9) || (hour >= 16 && hour <= 20) ? 8 : 2;
    case "university":
      return hour >= 8 && hour <= 18 ? 6 : 1;
    case "shopping":
      return hour >= 11 && hour <= 19 ? 5 : 1;
    default:
      return 0;
  }
}

function trafficPenaltyFromMinutes(minutes) {
  if (minutes <= 8) return 0;
  if (minutes <= 15) return 3;
  if (minutes <= 22) return 7;
  if (minutes <= 30) return 12;
  return 18;
}

function trafficLevel(minutes) {
  if (minutes <= 8) return "light";
  if (minutes <= 15) return "moderate";
  if (minutes <= 25) return "busy";
  return "heavy";
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.asin(Math.sqrt(a));
  return earthRadiusMiles * c;
}

function distancePenalty(miles) {
  if (miles < 2) return 0;
  if (miles < 5) return 4;
  if (miles < 8) return 8;
  if (miles < 12) return 14;
  return 22;
}

function estimateDriveMinutes(miles) {
  return Math.max(1, Math.round((miles / 25) * 60));
}

async function getTrafficDriveMinutes(originLon, originLat, destLon, destLat) {
  const token = process.env.MAPBOX_ACCESS_TOKEN;

  if (!token) return null;

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/` +
    `${originLon},${originLat};${destLon},${destLat}` +
    `?alternatives=false&geometries=geojson&overview=simplified&steps=false&access_token=${token}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Mapbox traffic request failed: ${response.status}`);
  }

  const data = await response.json();
  const route = data?.routes?.[0];

  if (!route?.duration) return null;

  return Math.max(1, Math.round(route.duration / 60));
}

function formatEventSummary(events) {
  if (!events.length) return "No major events detected";

  return events
    .slice(0, 5)
    .map((event) => {
      const parts = [event.name];

      if (event.venue) parts.push(`at ${event.venue}`);
      if (event.date) parts.push(`on ${event.date}`);
      if (event.time) parts.push(`at ${event.time}`);

      return parts.join(" ");
    })
    .join("\n");
}

app.get("/", (req, res) => {
  res.send("GigProfit AI backend running");
});

app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content: `
You are GigProfit AI, a smart, natural, human-sounding copilot for Uber and Lyft drivers.

Your goals:
- help drivers make better decisions
- sound practical, warm, and sharp
- avoid robotic phrasing
- answer clearly and conversationally
- focus on earnings, zones, timing, strategy, miles, and efficiency

Rules:
- do not use markdown tables
- do not sound academic
- do not over-explain
- if the driver asks if a ride is good, evaluate it using pay, miles, minutes, dollars per mile, and dollars per hour if available
- if the driver asks for advice, answer like a highly experienced rideshare strategist
          `.trim(),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content ?? "No response";
    res.json({ reply: text });
  } catch (error) {
    console.error("ASK ERROR:", error);
    res.status(500).json({ error: "AI request failed" });
  }
});

app.post("/radar/recommend", async (req, res) => {
  try {
    const {
      city = "Charlotte",
      latitude,
      longitude,
      hour,
      mode = "manual",
    } = req.body || {};

    const resolvedHour =
      typeof hour === "number" && hour >= 0 && hour <= 23
        ? hour
        : new Date().getHours();

    const cityZones = getCityZones(city);
    const events = await getNearbyEvents(city);

    let referenceLat = cityZones[0]?.lat ?? 35.2271;
    let referenceLon = cityZones[0]?.lon ?? -80.8431;

    if (typeof latitude === "number" && typeof longitude === "number") {
      referenceLat = latitude;
      referenceLon = longitude;
    }

    const scoredZones = await Promise.all(
      cityZones.map(async (zone) => {
        const miles = distanceMiles(referenceLat, referenceLon, zone.lat, zone.lon);

        let driveMinutes = estimateDriveMinutes(miles);
        let liveTraffic = false;

        try {
          const liveMinutes = await getTrafficDriveMinutes(
            referenceLon,
            referenceLat,
            zone.lon,
            zone.lat
          );

          if (typeof liveMinutes === "number") {
            driveMinutes = liveMinutes;
            liveTraffic = true;
          }
        } catch (trafficError) {
          console.error("TRAFFIC ERROR:", trafficError.message);
        }

        let eventBoost = 0;
        const nearbyEvents = [];

        for (const event of events) {
          if (typeof event.lat !== "number" || typeof event.lon !== "number") continue;

          const eventDistance = distanceMiles(zone.lat, zone.lon, event.lat, event.lon);

          if (eventDistance < 2) {
            eventBoost += 12;
            nearbyEvents.push(event.name);
          } else if (eventDistance < 5) {
            eventBoost += 6;
            nearbyEvents.push(event.name);
          }
        }

        const finalScore = Math.max(
          1,
          zone.baseScore +
            timeBonus(zone.type, resolvedHour) +
            eventBoost -
            distancePenalty(miles) -
            trafficPenaltyFromMinutes(driveMinutes)
        );

        return {
          ...zone,
          distanceMiles: Number(miles.toFixed(1)),
          driveMinutes,
          trafficLevel: trafficLevel(driveMinutes),
          liveTraffic,
          finalScore,
          eventBoost,
          nearbyEvents: Array.from(new Set(nearbyEvents)).slice(0, 3)
        };
      })
    );

    scoredZones.sort((a, b) => b.finalScore - a.finalScore);

    const aiPrompt = `
You are GigProfit Radar AI for Uber and Lyft drivers.

User city: ${city}
Mode: ${mode}
Current hour: ${resolvedHour}

Live events nearby:
${formatEventSummary(events)}

Top candidate zones:
${scoredZones
  .slice(0, 3)
  .map(
    (z, i) => `
${i + 1}. ${z.name}
type: ${z.type}
score: ${z.finalScore}
distance: ${z.distanceMiles} miles
drive time: ${z.driveMinutes} min
traffic level: ${z.trafficLevel}
expected earnings: ${z.expected}
description: ${z.description}
event boost: ${z.eventBoost}
nearby events: ${z.nearbyEvents.length ? z.nearbyEvents.join(", ") : "none"}
`
  )
  .join("\n")}

Write a short driver-friendly recommendation in plain English.

Format exactly like this:

Best move now: <zone>

Why:
<1-2 short lines>

Traffic:
<light / moderate / busy / heavy>

Expected:
<earnings>

Recommendation:
<Drive there now / Stay nearby / Maybe>
`.trim();

    const aiResponse = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are a concise radar copilot for Uber and Lyft drivers. Be direct and practical.",
        },
        { role: "user", content: aiPrompt },
      ],
    });

    const explanation =
      aiResponse.choices?.[0]?.message?.content ?? "No recommendation generated.";

    res.json({
      city,
      mode,
      hour: resolvedHour,
      bestZone: scoredZones[0],
      zones: scoredZones,
      explanation,
      events: events.slice(0, 5)
    });
  } catch (error) {
    console.error("RADAR ERROR:", error);
    res.status(500).json({ error: "Radar recommendation failed" });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GigProfit backend listening on port ${PORT}`);
});