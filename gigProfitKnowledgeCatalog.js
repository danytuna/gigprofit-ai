// Official GigProfit knowledge catalog generated from the current iOS project structure.
// Keep live plan prices, permissions, and user state authoritative in StoreKit/AccessManager.

const CATALOG = [
  {
    "id": "app_overview",
    "name": "GigProfit overview",
    "area": "Core",
    "screen": "Bottom navigation: Home / Drive / Tax / AI",
    "navigation": "Bottom navigation: Home / Drive / Tax / AI",
    "description": "GigProfit combines offer analysis, driver sessions, live driving tools, tax organization, safety recording, and AI assistance.",
    "howToUse": [
      "Use Home to analyze offers and view history.",
      "Use Drive for Driver Mode, map, Radar, Events, navigation, and safety tools.",
      "Use Tax for transactions, deductions, AI review, and exports.",
      "Use AI for questions, strategies, app help, and supported actions."
    ],
    "plan": "Core navigation is available after sign-in; individual features follow the live plan rules.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "what is gigprofit",
      "how does gigprofit work",
      "que es gigprofit",
      "como funciona gigprofit",
      "app overview",
      "pantallas",
      "tabs",
      "secciones"
    ],
    "actionTarget": "home",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "home",
    "name": "Home tab",
    "area": "Home",
    "screen": "Home tab",
    "navigation": "Home tab",
    "description": "Home is the main offer-analysis workspace. It contains the order analyzer, screenshot scan entry points, recent results, and history access.",
    "howToUse": [
      "Open the Home tab from the bottom navigation.",
      "Choose manual entry or screenshot analysis.",
      "Review the recommendation, score, dollars per mile, and estimated hourly rate."
    ],
    "plan": "Available on Free, Standard, and Pro; daily limits may apply to scans and history.",
    "permissions": [],
    "actions": [
      "Analyze an offer",
      "Scan a screenshot",
      "Open History"
    ],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "home",
      "inicio",
      "pantalla principal",
      "main screen"
    ],
    "actionTarget": "home",
    "related": [
      "order_analyzer",
      "scan_screenshot",
      "history"
    ],
    "stateChecks": []
  },
  {
    "id": "order_analyzer",
    "name": "Order Analyzer",
    "area": "Home",
    "screen": "Order Analyzer",
    "navigation": "Home > Order Analyzer",
    "description": "Analyzes payout, total miles, and total minutes against the driver’s saved profit rules and trip limits.",
    "howToUse": [
      "Open Home.",
      "Enter payout, miles, and minutes.",
      "Tap Analyze Ride.",
      "Review Trip Score, dollars per mile, estimated hourly rate, and the recommendation."
    ],
    "plan": "Core analyzer is available on all plans.",
    "permissions": [],
    "actions": [
      "Analyze ride",
      "Save result"
    ],
    "errors": [
      "Missing payout, miles, or minutes",
      "Invalid zero or negative values"
    ],
    "solutions": [
      "Enter all three required values",
      "Use the total trip distance and total expected time"
    ],
    "limitations": [
      "The recommendation is an estimate and cannot guarantee earnings or future demand."
    ],
    "keywords": [
      "analyze ride",
      "analizar viaje",
      "order analyzer",
      "ride analysis",
      "trip score",
      "acepto este viaje",
      "good order",
      "oferta"
    ],
    "actionTarget": "home",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "manual_entry",
    "name": "Manual offer entry",
    "area": "Home",
    "screen": "Manual",
    "navigation": "Home > Order Analyzer > Manual",
    "description": "Lets the user type offer values when a screenshot is unavailable or OCR misses information.",
    "howToUse": [
      "Open Home.",
      "Choose the manual entry option.",
      "Enter payout, miles, and minutes.",
      "Analyze and save if desired."
    ],
    "plan": "Available on all plans.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Required field missing"
    ],
    "solutions": [
      "Add payout, miles, and minutes before analyzing"
    ],
    "limitations": [],
    "keywords": [
      "manual entry",
      "entrada manual",
      "poner viaje manual",
      "type order"
    ],
    "actionTarget": "home",
    "related": [
      "order_analyzer"
    ],
    "stateChecks": []
  },
  {
    "id": "scan_screenshot",
    "name": "Scan Screenshot",
    "area": "Home",
    "screen": "Scan Screenshot",
    "navigation": "Home > Scan Screenshot",
    "description": "Lets the user choose a screenshot from Photos and extract offer details from supported gig-app layouts.",
    "howToUse": [
      "Open Home.",
      "Tap Scan Screenshot.",
      "Choose a clear offer screenshot from Photos.",
      "Review detected payout, miles, and time before using the result."
    ],
    "plan": "Free has a daily scan limit; Standard and Pro use the current unlimited-scan entitlement.",
    "permissions": [
      "Photos"
    ],
    "actions": [],
    "errors": [
      "Photos permission denied",
      "Unsupported screenshot layout",
      "Required values not detected",
      "Duplicate screenshot",
      "Daily limit reached"
    ],
    "solutions": [
      "Allow Photos access in iOS Settings",
      "Use a screenshot showing payout, miles, and time",
      "Try the full uncropped offer screen",
      "Check remaining daily scans"
    ],
    "limitations": [],
    "keywords": [
      "scan screenshot",
      "escanear captura",
      "cargar captura",
      "upload screenshot",
      "ocr",
      "uber screenshot",
      "lyft screenshot"
    ],
    "actionTarget": "home",
    "related": [
      "auto_scan",
      "instant_scan"
    ],
    "stateChecks": []
  },
  {
    "id": "auto_scan",
    "name": "Auto Scan",
    "area": "Home / Settings",
    "screen": "Auto Scan",
    "navigation": "Home > Auto Scan, or Settings > Money > Auto Scan",
    "description": "Monitors newly saved screenshots while the supported scan flow is active and analyzes gig offers automatically.",
    "howToUse": [
      "Open Settings > Money > Auto Scan.",
      "Enable Auto analyze screenshots.",
      "Turn on Driver Mode when using Easy Mode.",
      "Take a supported offer screenshot.",
      "Open the result notification, banner, or Live Activity."
    ],
    "plan": "Free: 5 scans per trusted day. Standard and Pro: current unlimited-scan entitlement.",
    "permissions": [
      "Photos",
      "Notifications when enabled"
    ],
    "actions": [
      "Enable or disable automatic analysis",
      "Show detected values",
      "Open Instant Scan setup"
    ],
    "errors": [
      "Daily limit reached",
      "Photos permission missing",
      "Unsupported or duplicate screenshot",
      "OCR could not find payout, miles, or time",
      "Backend unavailable",
      "Screenshot saved before monitoring became active"
    ],
    "solutions": [
      "Check current plan and remaining scans",
      "Allow Photos access",
      "Use an uncropped screenshot",
      "Keep Driver Mode active for Easy Mode",
      "Retry when online",
      "Use Instant Scan for a one-tap manual trigger"
    ],
    "limitations": [
      "Detection depends on image clarity and supported app layouts.",
      "A dashboard, map, or heat-zone screenshot is not an offer and should not consume an order analysis."
    ],
    "keywords": [
      "lyft no funciona con auto scan",
      "auto scan no funciona",
      "auto scan",
      "autoscan",
      "escaneo automatico",
      "captura automatica",
      "lyft no funciona",
      "uber scan",
      "missing order details",
      "no detecta orden"
    ],
    "actionTarget": "home",
    "related": [
      "scan_screenshot",
      "instant_scan",
      "auto_scan_cleanup"
    ],
    "stateChecks": []
  },
  {
    "id": "instant_scan",
    "name": "Instant Scan shortcut",
    "area": "Settings",
    "screen": "Enable Instant Scan",
    "navigation": "Settings > Money > Auto Scan > Enable Instant Scan",
    "description": "Installs the official Shortcuts workflow so an offer can be captured and analyzed without manually opening GigProfit first.",
    "howToUse": [
      "Open Settings > Money > Auto Scan.",
      "Tap Enable Instant Scan.",
      "Tap Add Shortcut in Shortcuts.",
      "Optionally assign it to AssistiveTouch or Back Tap.",
      "Trigger it while Uber or Lyft is showing the complete offer."
    ],
    "plan": "Uses the same scan access and daily limits as Auto Scan.",
    "permissions": [
      "Photos",
      "Shortcuts automation access",
      "Notifications or Live Activities when used"
    ],
    "actions": [],
    "errors": [
      "Shortcut not installed",
      "Latest screenshot is not the offer",
      "Shortcut returns no details"
    ],
    "solutions": [
      "Reinstall the official shortcut",
      "Wait for the offer to be fully visible",
      "Keep the screenshot-saving step and short delay in the shortcut"
    ],
    "limitations": [],
    "keywords": [
      "instant scan",
      "shortcut",
      "shortcuts",
      "assistivetouch",
      "back tap",
      "toque atras",
      "atajo",
      "scan without opening"
    ],
    "actionTarget": null,
    "related": [
      "auto_scan"
    ],
    "stateChecks": []
  },
  {
    "id": "auto_scan_cleanup",
    "name": "Scanned screenshot cleanup",
    "area": "Settings",
    "screen": "Daily Screenshot Cleanup / Delete Scanned Screenshots",
    "navigation": "Settings > Money > Daily Screenshot Cleanup / Delete Scanned Screenshots",
    "description": "Tracks screenshots already processed by GigProfit and can delete them from Photos automatically on later days or manually.",
    "howToUse": [
      "Enable Daily Screenshot Cleanup to remove processed screenshots from previous days when the app opens.",
      "Enable Suggest cleanup when Driver Mode ends for a reminder.",
      "Use Delete Scanned Screenshots for immediate cleanup.",
      "Confirm the iOS Photos deletion prompt."
    ],
    "plan": "Available wherever Auto Scan settings are available.",
    "permissions": [
      "Photos"
    ],
    "actions": [],
    "errors": [
      "No processed screenshots available",
      "iOS deletion confirmation denied"
    ],
    "solutions": [
      "Refresh the processed count",
      "Confirm deletion in the system prompt"
    ],
    "limitations": [],
    "keywords": [
      "delete scanned screenshots",
      "borrar capturas",
      "cleanup screenshots",
      "limpiar fotos",
      "daily screenshot cleanup"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "history",
    "name": "History",
    "area": "Home",
    "screen": "History",
    "navigation": "Home > History",
    "description": "Shows saved analyzed orders and Driver Mode sessions, with filters and summary metrics.",
    "howToUse": [
      "Open Home and switch to History, or open the History screen.",
      "Review Orders and Sessions.",
      "Use filters when available."
    ],
    "plan": "Free history is limited to 10 entries per trusted day in the current access manager; Standard and Pro have unlimited history.",
    "permissions": [],
    "actions": [],
    "errors": [
      "No history yet",
      "Expected item not saved"
    ],
    "solutions": [
      "Analyze or save an order",
      "Complete a Driver Mode session",
      "Check the active user account"
    ],
    "limitations": [],
    "keywords": [
      "history",
      "historial",
      "orders saved",
      "sesiones",
      "past scans",
      "recent history"
    ],
    "actionTarget": "home",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "drive_map",
    "name": "Drive map",
    "area": "Drive",
    "screen": "Drive tab",
    "navigation": "Drive tab",
    "description": "The Drive tab hosts the live map, Driver Mode, Radar, Events, navigation controls, and safety-recording access.",
    "howToUse": [
      "Open the Drive tab.",
      "Allow precise location for nearby and routing features.",
      "Use floating controls for Radar, Events, navigation, and recording."
    ],
    "plan": "Drive Map is available on all plans; premium subfeatures use live plan checks.",
    "permissions": [
      "Location"
    ],
    "actions": [],
    "errors": [
      "Map not ready",
      "Location unavailable"
    ],
    "solutions": [
      "Allow precise location",
      "Wait for the map to finish loading",
      "Check network access"
    ],
    "limitations": [],
    "keywords": [
      "drive map",
      "mapa",
      "drive tab",
      "map not loading",
      "mapa no carga"
    ],
    "actionTarget": "drive",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "driver_mode",
    "name": "Driver Mode",
    "area": "Drive / Settings",
    "screen": "Driver Mode",
    "navigation": "Drive tab or Settings > Driving > Driver Mode",
    "description": "Starts a work session, tracks elapsed time and session context, and supports Live Activities, Auto Scan workflows, tax context, and session history.",
    "howToUse": [
      "Open Drive or Settings.",
      "Turn Driver Mode on when work starts.",
      "Keep required location permission enabled.",
      "Stop Driver Mode when the work session ends.",
      "Review the saved session in History or Driver Sessions."
    ],
    "plan": "Available on all plans; monthly session limits may depend on the current plan model.",
    "permissions": [
      "Location",
      "Notifications for reminders and Live Activity"
    ],
    "actions": [],
    "errors": [
      "Session already active",
      "Location unavailable",
      "Idle auto-stop warning"
    ],
    "solutions": [
      "Stop the active session before starting another",
      "Allow location",
      "Respond to the idle warning or restart the session"
    ],
    "limitations": [],
    "keywords": [
      "driver mode",
      "modo conductor",
      "start shift",
      "sesion de trabajo",
      "end driver mode",
      "turn on driver mode"
    ],
    "actionTarget": "drive",
    "related": [
      "driver_sessions",
      "live_activities"
    ],
    "stateChecks": []
  },
  {
    "id": "driver_sessions",
    "name": "Driver Sessions",
    "area": "Settings / History",
    "screen": "Sessions",
    "navigation": "Settings > Driving > Driver Sessions, or Home > History > Sessions",
    "description": "Displays saved work sessions with time, earnings, miles, and efficiency metrics when available.",
    "howToUse": [
      "Open Settings > Driving > Driver Sessions or History > Sessions.",
      "Select a session to review its recorded details."
    ],
    "plan": "Session availability follows the current plan and retention rules.",
    "permissions": [],
    "actions": [],
    "errors": [
      "No sessions yet"
    ],
    "solutions": [
      "Complete a Driver Mode session first"
    ],
    "limitations": [],
    "keywords": [
      "driver sessions",
      "sesiones conductor",
      "work history",
      "historial trabajo"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "profit_rules",
    "name": "Profit Rules",
    "area": "Settings",
    "screen": "Profit Rules",
    "navigation": "Settings > Driving > Profit Rules",
    "description": "Sets the minimum dollars per mile and minimum hourly target used by order analysis and driver recommendations.",
    "howToUse": [
      "Open Settings > Driving > Profit Rules.",
      "Adjust Minimum $ / mile.",
      "Adjust Minimum $ / hour.",
      "Tap Save."
    ],
    "plan": "Available on all plans.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "donde cambio el minimo por milla",
      "where do i change minimum per mile",
      "profit rules",
      "reglas de ganancia",
      "minimum per mile",
      "minimum hourly",
      "dollars per mile target",
      "meta por milla"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "trip_limits",
    "name": "Trip Limits",
    "area": "Settings",
    "screen": "Trip Limits",
    "navigation": "Settings > Driving > Trip Limits",
    "description": "Sets maximum miles and maximum minutes used to flag offers outside the driver’s preferred limits.",
    "howToUse": [
      "Open Settings > Driving > Trip Limits.",
      "Set Maximum miles.",
      "Set Maximum minutes.",
      "Tap Save."
    ],
    "plan": "Available on all plans.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "trip limits",
      "limites viaje",
      "maximum miles",
      "maximum minutes",
      "max miles",
      "max time"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "long_trip_warning",
    "name": "Long Trip Warning",
    "area": "Settings",
    "screen": "Long Trip Warning",
    "navigation": "Settings > Driving > Long Trip Warning",
    "description": "Warns when an offer exceeds configured long-trip mileage or time thresholds and can optionally assume a return trip in analysis.",
    "howToUse": [
      "Open Settings > Driving > Long Trip Warning.",
      "Enable the warning.",
      "Set the miles and minutes thresholds.",
      "Optionally enable Assume return trip.",
      "Tap Save."
    ],
    "plan": "Available on all plans.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "long trip warning",
      "viaje largo",
      "return trip",
      "regreso",
      "warning long rides"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "vehicle_cost",
    "name": "Vehicle Cost",
    "area": "Settings",
    "screen": "Vehicle Cost",
    "navigation": "Settings > Money > Vehicle Cost",
    "description": "Stores an estimated cost per mile so GigProfit can show estimated real profit after vehicle costs.",
    "howToUse": [
      "Open Settings > Money > Vehicle Cost.",
      "Enable Show estimated real profit.",
      "Set Estimated cost per mile.",
      "Tap Save."
    ],
    "plan": "Available on all plans.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [
      "This is an estimate and not a replacement for actual bookkeeping."
    ],
    "keywords": [
      "vehicle cost",
      "costo vehiculo",
      "cost per mile",
      "real profit",
      "ganancia real"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "radar",
    "name": "Radar",
    "area": "Drive",
    "screen": "Radar",
    "navigation": "Drive > Radar",
    "description": "Shows currently loaded demand zones, community or app signals, and nearby opportunity context on the Drive map.",
    "howToUse": [
      "Open Drive.",
      "Open Radar or select a Radar area.",
      "Allow precise location.",
      "Refresh or choose a zone when data is available."
    ],
    "plan": "Radar Live and event signals are available to Standard and Pro in the current AccessManager.",
    "permissions": [
      "Location"
    ],
    "actions": [],
    "errors": [
      "No active Radar data",
      "Location unavailable",
      "Radar service unavailable"
    ],
    "solutions": [
      "Enable precise location",
      "Refresh after moving",
      "Check connection",
      "No data is a valid state and does not prove there is no real-world demand"
    ],
    "limitations": [
      "Radar signals are guidance, not guaranteed demand."
    ],
    "keywords": [
      "radar",
      "zona caliente",
      "busy zone",
      "demand area",
      "police",
      "traffic alert",
      "no radar data"
    ],
    "actionTarget": "radar",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "radar_area",
    "name": "Choose Radar Area",
    "area": "Drive",
    "screen": "Choose Radar Area",
    "navigation": "Drive > Radar > Choose Radar Area",
    "description": "Lets the user select which nearby area or zone should be emphasized by Radar.",
    "howToUse": [
      "Open Drive > Radar.",
      "Open Choose Radar Area.",
      "Select an available zone."
    ],
    "plan": "Follows Radar access.",
    "permissions": [
      "Location"
    ],
    "actions": [],
    "errors": [
      "No areas available"
    ],
    "solutions": [
      "Allow location and refresh Radar"
    ],
    "limitations": [],
    "keywords": [
      "choose radar area",
      "seleccionar zona radar",
      "radar selection",
      "choose zone"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "events",
    "name": "Events",
    "area": "Drive",
    "screen": "Events",
    "navigation": "Drive > Events",
    "description": "Searches Ticketmaster for concerts, games, and live events and loads nearby event signals for Copilot and driver planning.",
    "howToUse": [
      "Open Drive > Events.",
      "Enter an artist, event, or keyword.",
      "Optionally enter a city; otherwise allow location.",
      "Tap Search Ticketmaster.",
      "Open the Ticketmaster link or use the event in Copilot planning."
    ],
    "plan": "Event/Radar access is Standard or Pro in the current access manager.",
    "permissions": [
      "Location for nearby results"
    ],
    "actions": [],
    "errors": [
      "No events found for the selected range",
      "Ticketmaster unavailable",
      "Location disabled and no city entered"
    ],
    "solutions": [
      "Try another date, keyword, city, radius, or category",
      "Enable location",
      "Refresh events for Copilot"
    ],
    "limitations": [
      "Ticketmaster may not provide attendance, official end time, parking, or demand. Those must be labeled as estimates or unavailable."
    ],
    "keywords": [
      "events",
      "eventos",
      "ticketmaster",
      "concert",
      "concierto",
      "game",
      "partido",
      "refresh events",
      "copilot event memory"
    ],
    "actionTarget": "events",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "event_alerts",
    "name": "Event Alerts",
    "area": "Settings",
    "screen": "Event Alerts",
    "navigation": "Settings > Driving > Event Alerts",
    "description": "Controls notifications for large nearby events before they begin.",
    "howToUse": [
      "Open Settings > Driving.",
      "Turn Event Alerts on or off.",
      "Allow notifications in iOS Settings."
    ],
    "plan": "Uses the current event-access rules.",
    "permissions": [
      "Notifications",
      "Location for nearby matching"
    ],
    "actions": [],
    "errors": [
      "Alerts enabled in app but denied by iOS"
    ],
    "solutions": [
      "Enable GigProfit notifications in iOS Settings"
    ],
    "limitations": [],
    "keywords": [
      "event alerts",
      "alertas eventos",
      "5k events",
      "big event notifications"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "navigation",
    "name": "Navigation",
    "area": "Drive",
    "screen": "Start Navigation",
    "navigation": "Drive > Search destination > Start Navigation",
    "description": "Uses Google Maps and Navigation state to search destinations, start routes, show ETA and distance, provide voice guidance, and end navigation.",
    "howToUse": [
      "Open Drive.",
      "Search or select a destination.",
      "Start navigation.",
      "Follow map and voice guidance.",
      "Use End Route when finished."
    ],
    "plan": "Navigation uses the current live access state; the Drive map itself is available on all plans.",
    "permissions": [
      "Precise Location"
    ],
    "actions": [],
    "errors": [
      "Destination missing",
      "Location denied",
      "Navigation map not ready",
      "Route unavailable"
    ],
    "solutions": [
      "Select a valid destination",
      "Allow precise location",
      "Wait for the map to load",
      "Retry with a network connection"
    ],
    "limitations": [
      "ETA and traffic require live provider data."
    ],
    "keywords": [
      "navigation",
      "navegacion",
      "start route",
      "iniciar ruta",
      "end route",
      "terminar ruta",
      "eta",
      "directions",
      "llevarme"
    ],
    "actionTarget": "drive",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "navigation_voice",
    "name": "Navigation voice guidance",
    "area": "Drive",
    "screen": "Active Navigation",
    "navigation": "Drive > Active Navigation",
    "description": "Provides spoken route guidance while Google navigation is active.",
    "howToUse": [
      "Start a route in Drive.",
      "Make sure device audio is audible.",
      "Keep navigation active for voice instructions."
    ],
    "plan": "Follows navigation access.",
    "permissions": [
      "Location",
      "Audio output"
    ],
    "actions": [],
    "errors": [
      "No voice guidance"
    ],
    "solutions": [
      "Raise media volume",
      "Confirm a route is active",
      "Check silent/audio routing and app settings"
    ],
    "limitations": [],
    "keywords": [
      "navigation voice",
      "voz navegacion",
      "voice guidance",
      "no habla mapa"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "safety_recording",
    "name": "Safety Recording",
    "area": "Drive / Settings",
    "screen": "Recording Camera",
    "navigation": "Drive > Safety Mode, or Settings > Safety > Recording Camera",
    "description": "Records safety clips using the selected camera mode and stores completed clips in GigProfit’s recording library.",
    "howToUse": [
      "Open Drive > Safety Mode or Settings > Safety > Recording Camera.",
      "Choose Front, Rear, Dual, Automatic, or Off as supported.",
      "Start recording.",
      "Stop recording and wait for the saved confirmation.",
      "Open Safety Recordings to review the clip."
    ],
    "plan": "Manual recording is available in the current build; Safety Library and automatic recording are Standard or Pro; Dual Camera is Pro.",
    "permissions": [
      "Camera",
      "Microphone",
      "Photos only when exporting"
    ],
    "actions": [],
    "errors": [
      "Camera or microphone permission denied",
      "No frames received",
      "Failed to save recording",
      "Another app is using the camera",
      "Device does not support Dual Camera"
    ],
    "solutions": [
      "Allow Camera and Microphone in iOS Settings",
      "Close other camera apps",
      "Record for several seconds before stopping",
      "Use Front or Rear when Dual is unsupported",
      "Check available device storage"
    ],
    "limitations": [
      "Recording uses battery and storage.",
      "Dual Camera can increase temperature."
    ],
    "keywords": [
      "safety recording",
      "grabacion seguridad",
      "camera recording",
      "no guarda video",
      "record clip"
    ],
    "actionTarget": "safetyRecordings",
    "related": [
      "front_camera",
      "rear_camera",
      "dual_camera",
      "safety_library"
    ],
    "stateChecks": []
  },
  {
    "id": "recording_camera",
    "name": "Recording Camera selection",
    "area": "Settings",
    "screen": "Recording Camera",
    "navigation": "Settings > Safety > Recording Camera",
    "description": "Selects the camera mode used by Safety Mode and shows whether Dual Camera is supported or requires Pro.",
    "howToUse": [
      "Open Settings > Safety > Recording Camera.",
      "Choose the desired mode.",
      "If Dual is enabled, close and reopen GigProfit when the screen recommends it."
    ],
    "plan": "Front/Rear manual recording follows current access; Dual requires Pro.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "recording camera",
      "choose camera",
      "seleccionar camara",
      "camera mode",
      "automatic camera"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "front_camera",
    "name": "Front Camera recording",
    "area": "Safety",
    "screen": "Front Camera",
    "navigation": "Safety Mode > Front Camera",
    "description": "Records the cabin-facing/front camera with microphone audio.",
    "howToUse": [
      "Open Safety Mode.",
      "Select Front Camera.",
      "Start recording.",
      "Stop after the desired duration.",
      "Open Safety Recordings to verify the clip."
    ],
    "plan": "Manual safety recording available under current access.",
    "permissions": [
      "Camera",
      "Microphone"
    ],
    "actions": [],
    "errors": [
      "Black preview",
      "No saved clip"
    ],
    "solutions": [
      "Allow permissions",
      "Close another camera app",
      "Record for at least several seconds"
    ],
    "limitations": [],
    "keywords": [
      "front camera",
      "camara frontal",
      "selfie camera",
      "cabin recording"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "rear_camera",
    "name": "Rear Camera recording",
    "area": "Safety",
    "screen": "Rear Camera",
    "navigation": "Safety Mode > Rear Camera",
    "description": "Records the road-facing/rear camera with microphone audio using the configured 90-degree connection rotation.",
    "howToUse": [
      "Open Safety Mode.",
      "Select Rear Camera.",
      "Start recording.",
      "Stop and wait for the library save."
    ],
    "plan": "Manual safety recording available under current access.",
    "permissions": [
      "Camera",
      "Microphone"
    ],
    "actions": [],
    "errors": [
      "Rear recording starts but saves nothing",
      "Video orientation is wrong"
    ],
    "solutions": [
      "Allow camera and microphone",
      "Record for several seconds",
      "Keep the configured 90-degree connection rotation; do not add a second writer rotation"
    ],
    "limitations": [],
    "keywords": [
      "la camara trasera no guarda el video",
      "rear camera does not save",
      "rear camera",
      "camara trasera",
      "back camera",
      "rear video",
      "no graba trasera"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "dual_camera",
    "name": "Dual Camera recording",
    "area": "Safety",
    "screen": "Dual Camera",
    "navigation": "Safety Mode > Dual Camera",
    "description": "Records front and rear feeds together on compatible iPhones, with the rear camera as the main canvas and the front camera in picture-in-picture.",
    "howToUse": [
      "Open Settings > Safety > Recording Camera.",
      "Select Dual Camera if supported and Pro is active.",
      "Close and reopen GigProfit when prompted.",
      "Record from Safety Mode."
    ],
    "plan": "Pro.",
    "permissions": [
      "Camera",
      "Microphone"
    ],
    "actions": [],
    "errors": [
      "Unsupported device",
      "Dual camera could not start",
      "Front-only fallback"
    ],
    "solutions": [
      "Use a compatible iPhone",
      "Close and reopen the app after enabling Dual",
      "Use Front or Rear if multi-camera resources are unavailable"
    ],
    "limitations": [
      "Uses more battery and may increase temperature."
    ],
    "keywords": [
      "dual camera",
      "camara dual",
      "front and rear",
      "pip camera",
      "multi camera"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "auto_recording",
    "name": "Automatic safety recording",
    "area": "Settings",
    "screen": "Auto Recording",
    "navigation": "Settings > Safety > Auto Recording",
    "description": "Controls automatic safety recording tied to supported Drive/Driver Mode behavior.",
    "howToUse": [
      "Open Settings > Safety.",
      "Use Auto Recording to enable or disable the automatic behavior.",
      "Confirm the selected Recording Camera mode."
    ],
    "plan": "Standard or Pro in the current AccessManager.",
    "permissions": [
      "Camera",
      "Microphone"
    ],
    "actions": [],
    "errors": [
      "Plan required",
      "Camera permission denied"
    ],
    "solutions": [
      "Check plan",
      "Allow permissions"
    ],
    "limitations": [],
    "keywords": [
      "auto recording",
      "grabacion automatica",
      "automatic safety recording"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "safety_library",
    "name": "Safety Recordings library",
    "area": "Settings / Drive",
    "screen": "Safety Recordings",
    "navigation": "Settings > Safety > Safety Recordings, or Drive > Safety Recordings",
    "description": "Lists saved safety clips and supports playback, detail review, export, and deletion.",
    "howToUse": [
      "Open Safety Recordings.",
      "Tap a clip to play or inspect it.",
      "Use Share/Export when needed.",
      "Delete clips you no longer need."
    ],
    "plan": "Standard or Pro.",
    "permissions": [
      "Photos only when exporting to Photos"
    ],
    "actions": [],
    "errors": [
      "No clips",
      "Clip cannot play",
      "Export failed"
    ],
    "solutions": [
      "Create a recording first",
      "Check that the file still exists",
      "Retry export and check storage"
    ],
    "limitations": [],
    "keywords": [
      "safety recordings",
      "grabaciones guardadas",
      "recording library",
      "videos guardados",
      "export clip"
    ],
    "actionTarget": "safetyRecordings",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "mark_incident",
    "name": "Mark Incident",
    "area": "Safety",
    "screen": "Mark Incident",
    "navigation": "Safety Mode > Mark Incident",
    "description": "Marks the current safety session as an incident so the related recording/session can be identified later.",
    "howToUse": [
      "Open Safety Mode while recording or monitoring.",
      "Tap Mark Incident.",
      "Use Clear Incident to remove the mark if it was accidental."
    ],
    "plan": "Follows Safety Mode access.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "mark incident",
      "marcar incidente",
      "clear incident",
      "accident marker"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "tax_center",
    "name": "Tax Tracker / Tax Center",
    "area": "Tax",
    "screen": "Tax tab",
    "navigation": "Tax tab",
    "description": "Organizes gig income, expenses, transaction classifications, deduction estimates, connected banks, AI review, rules, and export-ready records for a selected tax year.",
    "howToUse": [
      "Open the Tax tab.",
      "Choose the tax year.",
      "Connect a bank or add records.",
      "Review transaction types and tax status.",
      "Run AI Tax Review if enabled.",
      "Export PDF or CSV after confirming classifications."
    ],
    "plan": "Tax tools and bank connection are Pro in the current AccessManager.",
    "permissions": [],
    "actions": [],
    "errors": [
      "No transactions",
      "Bank not connected",
      "Records need review",
      "Service unavailable"
    ],
    "solutions": [
      "Open Tax Tracker Setup",
      "Connect or refresh a bank",
      "Add manual records",
      "Review Needs Review items"
    ],
    "limitations": [
      "GigProfit provides organization and estimates, not legal or tax advice."
    ],
    "keywords": [
      "tax center",
      "tax tracker",
      "impuestos",
      "deductions",
      "deducciones",
      "tax tab"
    ],
    "actionTarget": "tax",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "bank_connection",
    "name": "Bank Connection",
    "area": "Tax / Settings",
    "screen": "Bank Connection",
    "navigation": "Settings > Tax & Bank > Tax Tracker Setup > Bank Connection",
    "description": "Uses Plaid production Link to connect eligible institutions and sync sanitized transaction data into the selected tax year.",
    "howToUse": [
      "Open Settings > Tax & Bank > Tax Tracker Setup.",
      "Open Bank Connection.",
      "Choose Connect/Add Bank.",
      "Complete Plaid Link.",
      "Wait for the sync, then review imported transactions."
    ],
    "plan": "Pro in the current AccessManager.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Institution login failed",
      "Link expired",
      "No supported accounts",
      "Bank disconnected",
      "Sync delayed"
    ],
    "solutions": [
      "Retry Plaid Link",
      "Confirm bank credentials with the institution",
      "Reconnect the bank",
      "Refresh after the institution finishes updating"
    ],
    "limitations": [
      "Availability and data timing depend on Plaid and the financial institution."
    ],
    "keywords": [
      "como conecto mi banco",
      "how do i connect my bank",
      "connect bank",
      "conectar banco",
      "bank connection",
      "plaid",
      "bank sync",
      "add another bank"
    ],
    "actionTarget": "tax",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "tax_transactions",
    "name": "Tax transactions",
    "area": "Tax",
    "screen": "Transactions",
    "navigation": "Tax > Transactions",
    "description": "Shows imported and manual records for the selected tax year, including income, expense, transfer, refund, classification, source, and review status.",
    "howToUse": [
      "Open Tax.",
      "Scroll to Transactions.",
      "Use search and account/source filters.",
      "Tap a transaction for Transaction Detail."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "tax transactions",
      "transacciones tax",
      "imported transactions",
      "transaction list",
      "filters tax"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "transaction_type",
    "name": "Transaction Type",
    "area": "Tax",
    "screen": "Transaction Type",
    "navigation": "Tax > Transaction Detail > Transaction Type",
    "description": "Separates records into Income, Expense, Transfer, or Refund so totals and exports treat them correctly.",
    "howToUse": [
      "Open a transaction.",
      "Open Edit classification.",
      "Choose Income, Expense, Transfer, or Refund.",
      "Save Classification."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Transfer counted as expense",
      "Refund counted as deduction"
    ],
    "solutions": [
      "Set the correct Transaction Type and save"
    ],
    "limitations": [
      "Transfers and refunds are excluded from deductible expense totals."
    ],
    "keywords": [
      "transaction type",
      "tipo transaccion",
      "income expense transfer refund",
      "ingreso gasto transferencia reembolso"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "tax_status",
    "name": "Tax Status and classification",
    "area": "Tax",
    "screen": "Edit classification",
    "navigation": "Tax > Transaction Detail > Edit classification",
    "description": "Stores whether a record is Business, Personal, Excluded, or Needs Review, plus deductibility, tax category, business-use percentage, and notes.",
    "howToUse": [
      "Open Transaction Detail.",
      "Choose Classification.",
      "Choose Deductibility and Tax category.",
      "Set Business use percentage when applicable.",
      "Add notes if needed.",
      "Tap Save Classification."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Transaction remains in Review",
      "Wrong deductible percentage"
    ],
    "solutions": [
      "Choose a confirmed status",
      "Set business-use percentage",
      "Save the classification"
    ],
    "limitations": [
      "Needs Review items are excluded from confirmed deductible totals."
    ],
    "keywords": [
      "tax status",
      "classification",
      "business personal review",
      "deductibility",
      "business use percentage",
      "tax category"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "ai_tax_review",
    "name": "AI Tax Review",
    "area": "Tax",
    "screen": "AI Tax Review",
    "navigation": "Tax > AI Tax Review",
    "description": "Reviews eligible transaction summaries through the authenticated backend, uses rules and AI, may use web merchant identification when enabled, and saves suggestions for user approval.",
    "howToUse": [
      "Open Tax > AI Tax Review.",
      "Choose Review mode.",
      "Optionally limit to high-confidence candidates.",
      "Allow transaction summaries if desired.",
      "Tap Start AI Review.",
      "Review saved suggestions before applying."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Review appears stuck",
      "No suggestions",
      "Backend or AI unavailable",
      "Transaction summaries disabled"
    ],
    "solutions": [
      "Use Reset and restart for a stuck review",
      "Enable transaction summaries",
      "Check connection",
      "Review ambiguous items manually"
    ],
    "limitations": [
      "Suggestions can be inaccurate and are not tax advice.",
      "Uncertain items should stay Needs Review."
    ],
    "keywords": [
      "ai tax review",
      "start tax review",
      "revision ai taxes",
      "tax ai",
      "stuck tax review",
      "review transactions"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "apply_suggestions",
    "name": "Apply Suggestions",
    "area": "Tax",
    "screen": "Apply suggestions",
    "navigation": "Tax > AI Tax Review > Apply suggestions",
    "description": "Applies only safe AI suggestions in batches, respects manual overrides, keeps uncertain transactions in Review, and persists partial successes.",
    "howToUse": [
      "Open AI Tax Review after suggestions are available.",
      "Choose Apply high confidence or Apply suggestions.",
      "Keep the screen open while classifications are saved.",
      "Review any skipped, failed, or Needs Review items."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Some suggestions failed",
      "Manual changes were skipped",
      "No suggestions saved"
    ],
    "solutions": [
      "Retry failed items",
      "Review ambiguous transactions manually",
      "Start a new review when needed"
    ],
    "limitations": [
      "A suggestion is not final until it is applied and persisted."
    ],
    "keywords": [
      "apply suggestions",
      "aplicar sugerencias",
      "apply high confidence",
      "saving classifications"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "tax_rules",
    "name": "Tax Rules",
    "area": "Tax",
    "screen": "Tax Rules",
    "navigation": "Tax > Tax Rules",
    "description": "Creates reusable classification rules with classification, deductibility, category, business-use percentage, enable/disable state, and optional retroactive application.",
    "howToUse": [
      "Open Tax Rules.",
      "Create a rule and choose classification, deductibility, category, and percentage.",
      "Save the rule.",
      "Use Apply for retroactive updates when desired."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Rule does not affect old transactions"
    ],
    "solutions": [
      "Use Apply retroactively",
      "Confirm the rule is enabled"
    ],
    "limitations": [],
    "keywords": [
      "tax rules",
      "reglas taxes",
      "classification rule",
      "apply retroactively"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "manual_tax_entry",
    "name": "Manual tax entry",
    "area": "Tax",
    "screen": "Add manual record",
    "navigation": "Tax > Add manual record",
    "description": "Adds an income or expense record when it was not imported from a connected account.",
    "howToUse": [
      "Open Tax.",
      "Use the manual-entry action.",
      "Enter date, amount, merchant/description, type, and classification.",
      "Save."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Required value missing"
    ],
    "solutions": [
      "Enter amount, date, and required classification details"
    ],
    "limitations": [],
    "keywords": [
      "manual tax entry",
      "add expense manually",
      "agregar gasto",
      "manual income"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "tax_settings",
    "name": "Tax Settings",
    "area": "Tax",
    "screen": "Tax Settings",
    "navigation": "Tax > Tax Settings",
    "description": "Controls AI Tax Review, transaction-summary permission, automatic high-confidence application, reprocessing, suggestion deletion, and rule deletion.",
    "howToUse": [
      "Open Tax Settings.",
      "Enable or disable AI Tax Review.",
      "Choose whether summaries may be sent to AI.",
      "Choose auto-apply behavior.",
      "Use maintenance actions only when needed."
    ],
    "plan": "Pro.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [
      "Deleting suggestions does not delete bank transactions.",
      "Deleting rules does not automatically undo classifications already applied."
    ],
    "keywords": [
      "tax settings",
      "ajustes tax",
      "enable ai tax review",
      "delete tax suggestions",
      "reprocess tax year"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "tax_export",
    "name": "PDF and CSV tax export",
    "area": "Tax",
    "screen": "Export for Taxes",
    "navigation": "Tax > Export for Taxes",
    "description": "Generates export files from persisted final classifications for the selected tax year, including transaction type, tax status, category, percentage, deductible amount, source, and reason.",
    "howToUse": [
      "Confirm transaction classifications.",
      "Open Export for Taxes.",
      "Choose PDF or CSV.",
      "Wait for background generation.",
      "Preview or share the file."
    ],
    "plan": "Premium report access is Pro in the current AccessManager.",
    "permissions": [],
    "actions": [],
    "errors": [
      "No records",
      "PDF generation failed",
      "Export totals do not match"
    ],
    "solutions": [
      "Confirm saved transactions exist",
      "Retry export",
      "Check that Needs Review, transfers, and refunds are not expected in confirmed deductions"
    ],
    "limitations": [
      "Needs Review is reported separately and is not counted as a confirmed deduction."
    ],
    "keywords": [
      "donde exporto el pdf",
      "where do i export the pdf",
      "export pdf",
      "export csv",
      "pdf taxes",
      "tax report",
      "reporte impuestos",
      "deductible amount"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "copilot",
    "name": "AI Copilot",
    "area": "AI",
    "screen": "AI tab",
    "navigation": "AI tab",
    "description": "Answers driver, live-information, event, navigation, Tax, and GigProfit-help questions using conversation state and the appropriate real tools.",
    "howToUse": [
      "Open the AI tab.",
      "Ask a complete question or continue the current conversation.",
      "Use suggested actions when available.",
      "Correct a misunderstanding with a clarification such as “Me refiero a…”."
    ],
    "plan": "Pro in the current AccessManager.",
    "permissions": [
      "Optional location",
      "Optional GigProfit activity context",
      "Optional financial summaries"
    ],
    "actions": [],
    "errors": [
      "Backend unavailable",
      "Tool unavailable",
      "Context misunderstood",
      "Plan required"
    ],
    "solutions": [
      "Check connection",
      "Clarify the goal or entity",
      "Enable only the context permissions you want",
      "Open Settings > AI Assistant"
    ],
    "limitations": [
      "Live facts require a successful real tool call.",
      "The Copilot must label estimates and cannot guarantee earnings."
    ],
    "keywords": [
      "ai copilot",
      "copilot",
      "assistant",
      "asistente",
      "ask ai",
      "chat ai"
    ],
    "actionTarget": "ai",
    "related": [],
    "stateChecks": []
  },
  {
    "id": "copilot_app_help",
    "name": "GigProfit Guide",
    "area": "AI",
    "screen": "Ask about GigProfit",
    "navigation": "AI Copilot > Ask about GigProfit",
    "description": "Uses the official internal GigProfit knowledge catalog to answer where a feature is, how to use it, what it requires, and how to troubleshoot it.",
    "howToUse": [
      "Ask a direct question such as “¿Cómo conecto mi banco?” or “¿Dónde exporto el PDF?”.",
      "Follow the exact in-app path in the answer.",
      "Use the action button when the requested screen supports direct opening."
    ],
    "plan": "Copilot requires Pro; the guide describes all features but does not bypass plan restrictions.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [
      "The guide must not claim a toggle or permission is active unless live app state was actually checked."
    ],
    "keywords": [
      "gigprofit guide",
      "help with app",
      "ayuda app",
      "como uso",
      "donde esta",
      "how do i use"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "copilot_memory",
    "name": "Copilot chat history and memory",
    "area": "Settings",
    "screen": "AI Privacy & Memory / Manage AI Data",
    "navigation": "Settings > AI > AI Assistant > AI Privacy & Memory / Manage AI Data",
    "description": "Controls saved chat history, personalized memory, GigProfit activity context, location context, financial summaries, exports, and deletion of AI data.",
    "howToUse": [
      "Open Settings > AI > AI Assistant.",
      "Choose whether to save chat history.",
      "Enable Personalized memory only after consent.",
      "Choose activity, location, and financial-summary context separately.",
      "Use View, Export, Clear, or Delete actions under Manage AI Data.",
      "Tap Save."
    ],
    "plan": "Copilot itself is Pro.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [
      "Location context should be city-level, not an exact private address.",
      "Financial context should use high-level summaries, not bank credentials."
    ],
    "keywords": [
      "ai memory",
      "memoria ai",
      "chat history",
      "historial chat",
      "delete memories",
      "export ai data",
      "location context",
      "financial summaries"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "copilot_sources",
    "name": "Copilot sources and tools",
    "area": "AI",
    "screen": "AI Copilot response source label",
    "navigation": "AI Copilot response source label",
    "description": "The visible source label identifies whether a response used Web, Ticketmaster, GigProfit Guide, GigProfit Data, Radar, Navigation, Tax, Local Action, Weather, Time context, AI, or Multiple Sources.",
    "howToUse": [
      "Read the source label below the response.",
      "Treat live claims as verified only when the matching real tool succeeded."
    ],
    "plan": "Check live in-app access/paywall",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [
      "An AI-only response must not claim it searched the web or checked live app data."
    ],
    "keywords": [
      "source label",
      "fuente respuesta",
      "web ticketmaster",
      "multiple sources",
      "gigprofit data label"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "copilot_actions",
    "name": "Copilot app actions",
    "area": "AI",
    "screen": "Supported action request",
    "navigation": "AI Copilot > Supported action request",
    "description": "Can open Tax Center, Events, Radar, or Safety Recordings; toggle Driver Mode and alerts; and start or end navigation when the action is supported and permitted.",
    "howToUse": [
      "Ask for a supported action directly.",
      "Review any permission or plan error.",
      "Confirm the app actually changed state before treating it as completed."
    ],
    "plan": "Actions obey live feature access; current local action routing generally requires Pro.",
    "permissions": [
      "Depends on action"
    ],
    "actions": [],
    "errors": [
      "Plan required",
      "Permission required",
      "Service unavailable"
    ],
    "solutions": [
      "Upgrade only if desired",
      "Grant the required permission",
      "Open the target feature manually"
    ],
    "limitations": [],
    "keywords": [
      "open tax center",
      "abre eventos",
      "activate driver mode",
      "desactiva alertas",
      "start navigation",
      "end route",
      "local action"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "settings",
    "name": "Settings",
    "area": "Settings",
    "screen": "Settings screen",
    "navigation": "Settings screen",
    "description": "The driver control center for Driving, Safety, Money, AI, Tax & Bank, App, Profile, subscription, and account controls.",
    "howToUse": [
      "Open the Settings button from the app UI.",
      "Choose the relevant group.",
      "Save inside detail screens when a Save button is shown."
    ],
    "plan": "Settings is available to signed-in users; individual features can be locked.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "settings",
      "ajustes",
      "configuracion",
      "driver control center"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "profile",
    "name": "Profile",
    "area": "Settings",
    "screen": "Profile",
    "navigation": "Settings > Profile",
    "description": "Shows and edits the profile photo, full name, phone, email, plan, account status, and app version.",
    "howToUse": [
      "Open Settings.",
      "Tap the profile card at the top.",
      "Edit the allowed fields.",
      "Save changes."
    ],
    "plan": "Available to signed-in users.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Profile changes not saved"
    ],
    "solutions": [
      "Complete required fields",
      "Check connection and sign-in state"
    ],
    "limitations": [],
    "keywords": [
      "profile",
      "perfil",
      "change name",
      "foto perfil",
      "personal info"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "phone_verification",
    "name": "Phone Verification",
    "area": "Settings / Profile",
    "screen": "Phone Verification",
    "navigation": "Settings > Profile > Phone Verification",
    "description": "Uses Firebase Phone Authentication to send an SMS code and mark the phone as verified.",
    "howToUse": [
      "Open Settings > Profile.",
      "Enter the number in international format.",
      "Tap Verify/Send Code.",
      "Enter the SMS code.",
      "Use Resend after the countdown if needed."
    ],
    "plan": "Available to signed-in users.",
    "permissions": [
      "Push Notifications / APNs support",
      "Network"
    ],
    "actions": [],
    "errors": [
      "SMS not received",
      "Too many attempts",
      "reCAPTCHA remains open",
      "Number blocked temporarily"
    ],
    "solutions": [
      "Confirm the country code",
      "Try a different valid number",
      "Wait before retrying after throttling",
      "Use Firebase test numbers during development",
      "Confirm APNs and Remote Notifications configuration"
    ],
    "limitations": [
      "Firebase can throttle a phone number after repeated attempts."
    ],
    "keywords": [
      "no me llega el sms de verificacion",
      "sms verification code not received",
      "verify phone",
      "verificar telefono",
      "sms code",
      "codigo confirmacion",
      "no llega sms",
      "recaptcha"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "email_verification",
    "name": "Email Verification",
    "area": "Authentication / Profile",
    "screen": "Verification email sent after email registration",
    "navigation": "Verification email sent after email registration",
    "description": "Sends a Firebase verification link to confirm the user’s email address.",
    "howToUse": [
      "Register or request another verification email.",
      "Open the message from GigProfit.",
      "Tap the verification link.",
      "Return to the app and refresh sign-in state if needed."
    ],
    "plan": "Available to email/password accounts.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Email went to spam",
      "Link expired",
      "Email not received"
    ],
    "solutions": [
      "Check Spam/Junk",
      "Request a new link",
      "Confirm the email address",
      "Wait for custom-domain DNS verification when changing the sender domain"
    ],
    "limitations": [],
    "keywords": [
      "verify email",
      "verificar correo",
      "email verification",
      "spam verification email"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "subscription",
    "name": "Free, Standard, and Pro",
    "area": "Settings",
    "screen": "Subscription, or paywall",
    "navigation": "Settings > Profile > Subscription, or paywall",
    "description": "Shows current access and StoreKit products. Free includes core tools; Standard unlocks current mid-tier features such as unlimited scans, Radar/Events, and Safety Library; Pro unlocks Copilot, Tax, bank connection, Dual Camera, and advanced tools according to live AccessManager checks.",
    "howToUse": [
      "Open Settings > Profile > Subscription.",
      "Review the live StoreKit offerings and current plan.",
      "Choose Upgrade if desired.",
      "Use Manage Subscription for Apple billing."
    ],
    "plan": "Prices and exact current entitlement must be read from StoreKit/paywall, not invented from documentation.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Products unavailable",
      "Purchase pending",
      "Access did not refresh"
    ],
    "solutions": [
      "Check App Store connection",
      "Wait for pending approval",
      "Use Restore Purchases"
    ],
    "limitations": [],
    "keywords": [
      "free standard pro",
      "plans",
      "subscription",
      "suscripcion",
      "premium",
      "upgrade",
      "price"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "restore_purchases",
    "name": "Restore Purchases",
    "area": "Settings",
    "screen": "Restore Purchases",
    "navigation": "Settings > Profile > Subscription > Restore Purchases",
    "description": "Asks StoreKit to restore eligible purchases for the Apple ID currently signed in on the device.",
    "howToUse": [
      "Open Subscription.",
      "Tap Restore Purchases.",
      "Wait for StoreKit to finish.",
      "Confirm the plan updates."
    ],
    "plan": "The restore action is available without an active paid plan.",
    "permissions": [],
    "actions": [],
    "errors": [
      "No eligible purchase",
      "Different Apple ID",
      "Store unavailable"
    ],
    "solutions": [
      "Use the Apple ID that made the purchase",
      "Check network and App Store status",
      "Try again later"
    ],
    "limitations": [
      "GigProfit cannot create an entitlement StoreKit does not verify."
    ],
    "keywords": [
      "como restauro mi compra",
      "how do i restore my purchase",
      "restore purchases",
      "restaurar compra",
      "recover subscription",
      "purchase not showing"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "notifications",
    "name": "Notifications and alerts",
    "area": "Settings / iOS Settings",
    "screen": "Notifications",
    "navigation": "Settings > relevant alert toggle, plus iOS Settings > GigProfit > Notifications",
    "description": "Controls event alerts, scan notifications, Driver Mode reminders, and other supported alerts. Turning an app toggle off cancels its related pending notifications when implemented.",
    "howToUse": [
      "Turn the feature alert on or off inside GigProfit.",
      "If no alerts arrive, open iOS Settings > GigProfit > Notifications and allow them."
    ],
    "plan": "Core notification settings are available; the related feature may require a plan.",
    "permissions": [
      "Notifications"
    ],
    "actions": [],
    "errors": [
      "App toggle on but system permission off"
    ],
    "solutions": [
      "Enable notifications in iOS Settings"
    ],
    "limitations": [],
    "keywords": [
      "notifications",
      "notificaciones",
      "alerts",
      "alertas",
      "no notification"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "live_activities",
    "name": "Live Activities and Dynamic Island",
    "area": "Driver Mode / Lock Screen",
    "screen": "Start Driver Mode or supported scan activity",
    "navigation": "Start Driver Mode or supported scan activity",
    "description": "Displays supported ongoing status on the Lock Screen and Dynamic Island, such as Driver Mode or scan-analysis progress/results.",
    "howToUse": [
      "Enable Live Activities for GigProfit in iOS Settings.",
      "Start Driver Mode or a supported activity.",
      "End the session/activity to dismiss it."
    ],
    "plan": "Driver Mode Live Activity is available under current access; Dynamic Island requires supported hardware.",
    "permissions": [
      "Live Activities",
      "Notifications may be used for related alerts"
    ],
    "actions": [],
    "errors": [
      "Live Activity not appearing",
      "Old activity remains"
    ],
    "solutions": [
      "Enable Live Activities in iOS Settings",
      "Restart the active session",
      "Force-close only for diagnosis"
    ],
    "limitations": [
      "Dynamic Island presentation requires a supported iPhone."
    ],
    "keywords": [
      "como activo dynamic island",
      "how do i enable dynamic island",
      "live activity",
      "dynamic island",
      "isla dinamica",
      "lock screen",
      "actividad en vivo"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "language",
    "name": "App Language",
    "area": "Settings",
    "screen": "App Language",
    "navigation": "Settings > App > App Language",
    "description": "Changes the supported GigProfit interface language.",
    "howToUse": [
      "Open Settings > App > App Language.",
      "Choose a supported language."
    ],
    "plan": "Available to all signed-in users.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "app language",
      "idioma",
      "language settings",
      "cambiar idioma"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "reset_settings",
    "name": "Reset All Settings",
    "area": "Settings",
    "screen": "Reset All Settings",
    "navigation": "Settings > App > Reset All Settings",
    "description": "Restores GigProfit preferences to their defaults without deleting the user account.",
    "howToUse": [
      "Open Settings > App.",
      "Tap Reset All Settings.",
      "Confirm Reset."
    ],
    "plan": "Available to signed-in users.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [
      "Account data is not deleted by this action."
    ],
    "keywords": [
      "reset settings",
      "restablecer ajustes",
      "defaults",
      "reset all"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "logout",
    "name": "Log Out",
    "area": "Settings",
    "screen": "Log Out",
    "navigation": "Settings > Profile > Account > Log Out",
    "description": "Ends the current GigProfit session on the device.",
    "howToUse": [
      "Open Settings > Profile.",
      "Tap Log Out.",
      "Confirm if prompted."
    ],
    "plan": "Available to signed-in users.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "log out",
      "logout",
      "cerrar sesion",
      "sign out"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "delete_account",
    "name": "Delete Account",
    "area": "Settings",
    "screen": "Delete Account",
    "navigation": "Settings > Profile > Account > Delete Account",
    "description": "Permanently deletes the Firebase account after confirmation and reauthentication, and attempts to remove private profile, AI, tax, bank-link, and settings data.",
    "howToUse": [
      "Open Settings > Profile > Delete Account.",
      "Read the permanent-deletion warning.",
      "Type DELETE.",
      "Reauthenticate using the required method.",
      "Confirm deletion."
    ],
    "plan": "Available to signed-in users.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Reauthentication required",
      "Deletion failed"
    ],
    "solutions": [
      "Use the original sign-in provider",
      "Check connection and retry"
    ],
    "limitations": [
      "Deletion is permanent."
    ],
    "keywords": [
      "delete account",
      "eliminar cuenta",
      "borrar cuenta",
      "permanent deletion"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "legal_support",
    "name": "Legal documents and contact",
    "area": "Settings",
    "screen": "Disclaimer / Terms & Conditions / Privacy Policy / Contact",
    "navigation": "Settings > App > Disclaimer / Terms & Conditions / Privacy Policy / Contact",
    "description": "Provides the app disclaimer, terms, privacy policy, and support/business contact information.",
    "howToUse": [
      "Open Settings > App.",
      "Choose the desired legal document or Contact."
    ],
    "plan": "Available to signed-in users.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "terms",
      "privacy policy",
      "disclaimer",
      "contact support",
      "soporte",
      "legal"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "onboarding",
    "name": "Onboarding and tours",
    "area": "App setup",
    "screen": "First launch and spotlight tours",
    "navigation": "First launch and spotlight tours",
    "description": "Introduces GigProfit screens and highlights key controls. Tours can be shown during onboarding and may be reset through app preferences when supported.",
    "howToUse": [
      "Complete the first-launch setup.",
      "Follow spotlight prompts.",
      "Use the available reset-tour option if shown in Settings or the relevant screen."
    ],
    "plan": "Available to new users.",
    "permissions": [],
    "actions": [],
    "errors": [],
    "solutions": [],
    "limitations": [],
    "keywords": [
      "onboarding",
      "tour",
      "tutorial",
      "spotlight",
      "how to start",
      "primer uso"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  },
  {
    "id": "permissions",
    "name": "App permissions",
    "area": "Settings / iOS Settings",
    "screen": "GigProfit",
    "navigation": "GigProfit feature prompt, then iOS Settings > GigProfit",
    "description": "GigProfit requests only feature-specific access: location for Drive/Events/Navigation, Photos for screenshot scanning and export, Camera/Microphone for recording, Notifications/APNs for alerts and phone verification, and Live Activities where supported.",
    "howToUse": [
      "Open the feature that needs access and respond to the system prompt.",
      "To change a denied permission, open iOS Settings > GigProfit."
    ],
    "plan": "Permissions do not unlock paid features.",
    "permissions": [],
    "actions": [],
    "errors": [
      "Permission denied or restricted"
    ],
    "solutions": [
      "Change the permission in iOS Settings",
      "Check Screen Time or device restrictions"
    ],
    "limitations": [],
    "keywords": [
      "permissions",
      "permisos",
      "location permission",
      "photos permission",
      "camera permission",
      "microphone permission"
    ],
    "actionTarget": null,
    "related": [],
    "stateChecks": []
  }
];


function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9$+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalize(value).split(" ").filter((token) => token.length > 1));
}

function phraseScore(haystack, phrase) {
  const normalizedPhrase = normalize(phrase);
  if (!normalizedPhrase) return 0;
  if (haystack === normalizedPhrase) return 24;
  if (haystack.includes(normalizedPhrase)) return normalizedPhrase.includes(" ") ? 14 : 6;
  return 0;
}

export function searchGigProfitKnowledge(question, state = {}, limit = 5) {
  const input = normalize(question);
  const inputTokens = tokens(input);
  const context = normalize([
    state.activeTopic,
    state.activeGoal,
    state.activeIntent,
    state.activePlatform,
    state.activeLocation,
    JSON.stringify(state.activeEntities || []),
    JSON.stringify(state.knownFacts || []),
    state.lastUserCorrection,
  ].filter(Boolean).join(" "));
  const contextTokens = tokens(context);

  return CATALOG.map((entry) => {
    let score = 0;
    score += phraseScore(input, entry.name);
    score += phraseScore(input, entry.id.replaceAll("_", " "));
    score += phraseScore(input, entry.navigation);

    for (const keyword of entry.keywords || []) {
      score += phraseScore(input, keyword);
      if (context) score += Math.min(4, phraseScore(context, keyword) / 3);
    }

    const searchable = tokens([
      entry.name,
      entry.area,
      entry.screen,
      entry.navigation,
      entry.description,
      entry.howToUse.join(" "),
      entry.errors.join(" "),
      entry.solutions.join(" "),
      entry.keywords.join(" "),
    ].join(" "));

    for (const token of inputTokens) {
      if (searchable.has(token)) score += token.length >= 6 ? 2.4 : 1.2;
    }
    for (const token of contextTokens) {
      if (searchable.has(token)) score += 0.35;
    }

    if (input.includes("como") || input.includes("how")) score += entry.howToUse.length ? 1 : 0;
    if (input.includes("no funciona") || input.includes("fall") || input.includes("error") || input.includes("problema")) {
      score += entry.errors.length || entry.solutions.length ? 2 : 0;
    }

    return { entry, score };
  })
    .filter(({ score }) => score >= 4)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, Math.max(1, limit))
    .map(({ entry, score }) => ({ ...entry, relevanceScore: Number(score.toFixed(2)), catalogVersion: 2 }));
}

export const GIGPROFIT_KNOWLEDGE_CATALOG = Object.freeze(CATALOG);
