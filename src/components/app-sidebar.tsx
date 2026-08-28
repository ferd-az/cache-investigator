import { Activity01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Link, useLocation } from "react-router-dom";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation();

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to="/" aria-label="watchtower home" />}
            >
              <span className="flex size-5 items-center justify-center rounded bg-primary text-primary-foreground">
                <HugeiconsIcon
                  icon={Activity01Icon}
                  size={14}
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
              </span>
              <span className="text-[13px] font-semibold">watchtower</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="text-[13px]"
                  isActive={
                    location.pathname === "/" ||
                    location.pathname.startsWith("/i/")
                  }
                  tooltip="Investigations"
                  render={<Link to="/" />}
                >
                  <HugeiconsIcon
                    icon={Search01Icon}
                    size={15}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                  <span>Investigations</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
