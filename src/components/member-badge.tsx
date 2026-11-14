/**
 * A person, as a coloured disc.
 *
 * Five identical smiley faces is why the family row looked generic: every
 * member carries `avatar_emoji` and `accent_color` columns, and nothing ever
 * filled them in. Two decisions fix that.
 *
 * First, the fallback is never neutral. A member with nothing configured
 * still gets a colour, chosen deterministically from their id, and their own
 * initial rather than a shared smiley. The app looks like a family's before
 * anybody has opened Settings, which matters because most people never do.
 *
 * Second, the colour is a FIXED PALETTE rather than a free choice. Six hues,
 * each checked against white text and against both page themes. A colour
 * wheel in front of a seven-year-old produces yellow on white inside a week.
 */

/** Curated, legible with white text, distinguishable from one another. */
export const MEMBER_COLOURS = [
  "#c2582f", // terracotta
  "#2f6f8f", // teal
  "#6b4fa8", // violet
  "#4a7a46", // moss
  "#8a6a2f", // ochre
  "#9b4a6f", // plum
] as const;

export interface BadgePerson {
  id: string;
  display_name: string;
  avatar_emoji?: string | null;
  accent_color?: string | null;
}

/**
 * Their colour: the one they chose, or a stable one derived from their id.
 *
 * Derived rather than random so it never changes between renders, devices or
 * reloads — a child's colour is part of how they find their own row, so it
 * has to be the same every time even before anyone picks one.
 */
export function memberColour(person: BadgePerson): string {
  if (person.accent_color) return person.accent_color;
  let hash = 0;
  for (const ch of person.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return MEMBER_COLOURS[hash % MEMBER_COLOURS.length];
}

/** What goes inside the disc: their emoji, or the first letter of their name. */
export function memberGlyph(person: BadgePerson): string {
  if (person.avatar_emoji) return person.avatar_emoji;
  return person.display_name.trim().charAt(0).toUpperCase() || "?";
}

const SIZES = {
  sm: "h-8 w-8 text-sm",
  md: "h-11 w-11 text-lg",
  lg: "h-14 w-14 text-2xl",
  xl: "h-[72px] w-[72px] text-3xl",
} as const;

export function MemberBadge({
  person,
  size = "md",
  className = "",
}: {
  person: BadgePerson;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const colour = memberColour(person);
  const glyph = memberGlyph(person);
  // An emoji keeps its own colours; an initial is drawn in white on the
  // member's colour, which is what makes the row scannable at a distance.
  const isEmoji = Boolean(person.avatar_emoji);

  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center rounded-full font-[family-name:var(--font-display)] font-bold ${SIZES[size]} ${className}`}
      style={
        isEmoji
          ? { backgroundColor: `${colour}22`, border: `2px solid ${colour}` }
          : { backgroundColor: colour, color: "#fff" }
      }
    >
      {glyph}
    </span>
  );
}
