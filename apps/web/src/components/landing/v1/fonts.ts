import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";

export const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--lp1-display", display: "swap" });
export const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--lp1-mono", display: "swap" });
