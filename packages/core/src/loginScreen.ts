/**
 * What the sign-in screen says while it waits, shared by the web
 * (LoginScreen, HalftoneBackground) and the mobile app.
 */

/** Lines that type themselves out on the screen behind the sign-in card. */
export const LOGIN_SENTENCES: readonly string[] = [
  // chat culture
  "you up?",
  "lol that's wild",
  "brb getting snacks",
  "typing...",
  "no u",
  "sent from my toaster",
  "read at 3:47am",
  "new chat who dis",
  "tl;dr it was chaos",
  "gg no re",
  "hot take incoming",
  "big if true",
  "source: trust me bro",
  "based and redpilled",
  "inb4 someone disagrees",
  "lurking intensifies",
  "skill issue tbh",
  "ratio'd in real time",
  "certified hood classic",
  "least unhinged user",
  // space & astronomy
  "voyager 1 is 24 billion km away",
  "the sun mass is 99.86% of solar system",
  "a day on venus is longer than its year",
  "neutron stars spin 716 times per second",
  "olympus mons is 2.5x everest's height",
  "there are more stars than grains of sand",
  "saturn would float in a big enough bath",
  "light takes 8 minutes from sun to earth",
  "the moon drifts 3.8cm away each year",
  "space smells like seared steak apparently",
  "andromeda is on a collision course with us",
  "one teaspoon of neutron star weighs 6B tons",
  // computing & tech
  "there are 10 types of people in the world",
  "the first computer bug was an actual moth",
  "null pointer walked into a bar. segfault",
  "rm -rf / moment",
  "it works on my machine",
  "have you tried turning it off and on again",
  "localhost is where the heart is",
  "chmod 777 and pray",
  "the cloud is just someone else's computer",
  "linux users btw",
  "vim users are still trying to exit",
  "git push --force and hope for the best",
  "sudo make me a sandwich",
  "there's no place like 127.0.0.1",
  "malloc failed. everything failed.",
  "99 little bugs in the code. fix one. 127.",
  // nerdy fun facts
  "honey never spoils. ever.",
  "octopi have three hearts and blue blood",
  "a group of flamingos is called a flamboyance",
  "bananas are technically berries",
  "oxford university is older than the aztecs",
  "cleopatra lived closer to pizza hut than pyramids",
  "the mantis shrimp sees 16 color channels",
  "tardigrades survive the vacuum of space",
  "a jiffy is an actual unit of time (1/100s)",
  "sharks are older than trees",
  // protocol & network
  "ping",
  "pong",
  "ack",
  "syncing vibes...",
  "packet lost in transit",
  "buffering...",
  "connection established",
  "decrypting gossip...",
  "negotiating bandwidth",
  "TCP handshake complete",
  "404 sleep not found",
  "418 i'm a teapot",
  "establishing encrypted channel...",
  // atmospheric
  "whispers in the void",
  "murmurs on the wire",
  "echoes of conversations",
  "fragments of thought",
  "signals in the static",
  "ghosts in the machine",
  "damnation - milk",
  "ur mum -emu",
  "bullish -falken",
  "scandalous -rebond",
  "clusterfuck -kenna",
  "Soon™ - banji"


];

/** The connection sequence shown while signing in, with when each line appears. */
export const LOGIN_CONNECTION_STEPS: readonly { ms: number; text: string }[] = [
  { ms: 0, text: "initializing handshake..." },
  { ms: 500, text: "verifying credentials..." },
  { ms: 1000, text: "establishing encrypted channel..." },
  { ms: 1500, text: "routing to server endpoint..." },
  { ms: 2000, text: "syncing session state..." },
  { ms: 2500, text: "connection established." },
];
