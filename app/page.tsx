import { RadarDashboard } from "@/app/radar-dashboard";
import { seedPayload } from "@/app/seed-data";

export default function Home() {
  return <RadarDashboard initialPayload={seedPayload} />;
}
