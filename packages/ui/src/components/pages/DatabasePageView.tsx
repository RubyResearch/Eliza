/**
 * The Database nav tab: a segmented control switching between the SQL/table
 * DatabaseView, the MediaGalleryView, and the heavy vector-browser surface. The
 * vector browser is a three.js/WebGL view that ships in its own plugin bundle
 * and loads dynamically, so THREE only downloads when the user opens that tab.
 */

import type { ReactNode } from "react";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
  FramedPageNavigation,
} from "../../layouts/framed-page";
import { DATABASE_VECTOR_VIEW } from "../../navigation/builtin-route-descriptors";
import { useAppSelector } from "../../state";
import { SegmentedControl } from "../ui/segmented-control";
import { DynamicViewLoader } from "../views/DynamicViewLoader";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { DatabaseView } from "./DatabaseView";
import { MediaGalleryView } from "./MediaGalleryView";

// VectorBrowserView is a heavy three.js (WebGL) surface and pulls the injected
// THREE runtime. It lives in its own plugin package and is loaded dynamically
// so it (and three) only ship when the user actually opens the vectors tab,
// never with the always-loaded Database page.

export function DatabasePageView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const t = useAppSelector((s) => s.t);
  const databaseSubTab = useAppSelector((s) => s.databaseSubTab);
  const setState = useAppSelector((s) => s.setState);
  const dbTabs = [
    {
      id: "tables" as const,
      label: t("databaseview.Tables"),
    },
    {
      id: "media" as const,
      label: t("mediagalleryview.Media"),
    },
    {
      id: "vectors" as const,
      label: t("common.vectors"),
    },
  ];

  const selectTab = (v: "tables" | "media" | "vectors") =>
    setState("databaseSubTab", v);

  const leftNav = (
    <>
      <SegmentedControl
        value={databaseSubTab}
        onValueChange={selectTab}
        items={dbTabs.map((tab) => ({
          value: tab.id,
          label: tab.label,
          agentId: `tab-${tab.id}`,
          agentLabel: tab.label,
          agentGroup: "database-views",
        }))}
        role="tablist"
        aria-label={t("aria.databaseViews")}
      />
    </>
  );

  let content: ReactNode;
  if (databaseSubTab === "media") {
    content = <MediaGalleryView />;
  } else if (databaseSubTab === "vectors") {
    content = (
      <DynamicViewLoader
        {...DATABASE_VECTOR_VIEW}
        viewProps={{ leftNav, contentHeader }}
      />
    );
  } else {
    content = <DatabaseView layout="page" />;
  }
  return (
    <ShellViewAgentSurface viewId="database">
      <FramedPage gutterOwner="framed-page">
        <FramedPageHeader title="Databases" actions={contentHeader} />
        <FramedPageNavigation>{leftNav}</FramedPageNavigation>
        <FramedPageBody scroll="view" padded={false}>
          {content}
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
