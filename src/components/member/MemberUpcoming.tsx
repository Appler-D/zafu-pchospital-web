"use client";

import { FavoriteRow } from "@/components/community/FavoriteList";
import { NotificationRow } from "@/components/community/NotificationInbox";
import { Button } from "@/components/ui/Button";
import { communityCopy } from "@/config/community";
import { memberCopy } from "@/config/member";
import type { MemberFavoriteSummary, MemberNotificationSummary } from "@/types/contracts";

/** 通知与收藏摘要。 */

export type MemberUpcomingProps = {
  notifications: MemberNotificationSummary;
  favorites: MemberFavoriteSummary;
  onRetry: () => void;
};

export function MemberUpcoming({ notifications, favorites, onRetry }: MemberUpcomingProps) {
  const copy = memberCopy.dashboard;
  const notice = communityCopy.notifications;
  const fav = communityCopy.favorites;

  return (
    <div className="member-upcoming">
      <div className="community-summary">
        <section
          className="community-summary__panel"
          aria-labelledby="member-upcoming-notifications"
        >
          <header className="community-summary__head">
            <h3 className="community-summary__title" id="member-upcoming-notifications">
              {copy.upcomingNotifications}
            </h3>
            {notifications.available ? (
              <span className="community-summary__count">
                {notice.unreadCount.replace("{count}", String(notifications.unreadCount))}
              </span>
            ) : null}
          </header>
          {notifications.available ? (
            notifications.latest.length === 0 ? (
              <p className="member-section__note">{notice.empty}</p>
            ) : (
              <ul className="community-list community-list--compact">
                {notifications.latest.map((item) => (
                  <li
                    className={`community-list__item ${item.status === "UNREAD" ? "is-unread" : ""}`}
                    key={item.id}
                  >
                    <NotificationRow item={item} />
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionError onRetry={onRetry} />
          )}
        </section>

        <section className="community-summary__panel" aria-labelledby="member-upcoming-favorites">
          <header className="community-summary__head">
            <h3 className="community-summary__title" id="member-upcoming-favorites">
              {copy.upcomingFavorites}
            </h3>
            {favorites.available ? (
              <span className="community-summary__count">
                {fav.count.replace("{count}", String(favorites.count))}
              </span>
            ) : null}
          </header>
          {favorites.available ? (
            favorites.latest.length === 0 ? (
              <p className="member-section__note">{fav.empty}</p>
            ) : (
              <ul className="community-list community-list--compact">
                {favorites.latest.map((item) => (
                  <li className="community-list__item" key={item.id}>
                    <FavoriteRow item={item} />
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionError onRetry={onRetry} />
          )}
        </section>
      </div>
    </div>
  );
}

function SectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="member-section__error" role="status">
      <p>{memberCopy.common.sectionLoadError}</p>
      <Button onClick={onRetry}>{memberCopy.common.reload}</Button>
    </div>
  );
}
