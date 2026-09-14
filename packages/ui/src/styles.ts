/**
 * Renderer-only entry point (`@elizaos/ui/styles`) for the package's bundled
 * stylesheets. Apps that want the default UI styles import this module
 * explicitly. Kept separate from `./index.ts` so Node-side plugin loaders can
 * import the UI barrel without triggering a CSS module evaluation (Node refuses
 * ".css" extensions out of the box).
 */
import "./styles/styles.css";
import "./styles/brand-gold.css";
// The shared sheet owns Tailwind; importing the standalone Cloud sheet here
// would emit base utilities again after responsive overrides.
import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import "@elizaos/ui/styles/login.css";
