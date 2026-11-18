import { Hash } from "lucide-react";
import type { Team } from "@teams/model";
import { cn } from "@/shared/utils";
import { Avatar } from "./Avatar";

export function TeamAvatar({
  team,
  className,
}: {
  team: Pick<Team, "avatar">;
  className?: string;
}) {
  return (
    <Avatar
      avatar={team.avatar}
      fallback={<Hash className="size-[60%]" />}
      className={cn("size-7 rounded-lg", className)}
    />
  );
}
