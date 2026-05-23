import { QualityCheckSettings } from "@/components/qc/quality-check-settings";

export const metadata = {
  title: "Quality Check · MakerMods",
};

export default function QualityCheckSettingsPage() {
  return (
    <div className="container mx-auto p-6">
      <QualityCheckSettings />
    </div>
  );
}
