import { useColorScheme } from "react-native";

const light = {
  bg: "#F6F6F4",
  card: "#FFFFFF",
  text: "#14161A",
  muted: "#6B7079",
  border: "#E3E3DF",
  accent: "#3D63DD",
  good: "#2F9E5B",
  warn: "#C77D12",
  bad: "#D1403B",
  chip: "#EEEEEA",
};

const dark: typeof light = {
  bg: "#0E1116",
  card: "#171B22",
  text: "#ECEDEE",
  muted: "#8A9099",
  border: "#262C35",
  accent: "#7B9BFF",
  good: "#4CC27F",
  warn: "#E2A33B",
  bad: "#F06A64",
  chip: "#222833",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
