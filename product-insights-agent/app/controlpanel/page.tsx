import { notFound } from "next/navigation";
import { ControlPanelPage } from "@/controlpanel/ControlPanelPage";

export const metadata = {
  title: "Widget Control Panel — Product Insights",
};

export default function Page() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  return <ControlPanelPage />;
}
