import { useId } from 'react';

// Procedural collectible artwork, not a claimed on-chain NFT preview.
export function BadgeArt({ seed = 'atlas', rarity = 'epic', muted = false, large = false }: { seed?: string; rarity?: string; muted?: boolean; large?: boolean }) {
  const id = useId().replace(/:/g, '');
  const variant = [...seed].reduce((n, char) => n + char.charCodeAt(0), 0) % 6;
  const motifs = [
    <path key="compass" d="M80 39 90 70 121 80 90 90 80 121 70 90 39 80 70 70Z M80 63 97 80 80 97 63 80Z" />,
    <path key="summit" d="M39 105 66 53 80 76 96 39 121 105Z M66 53 75 70 58 70 M96 39 105 63 87 63 M55 105 81 105" />,
    <path key="wings" d="M80 115 56 92 43 57 71 68 80 47 89 68 117 57 104 92Z M43 57 70 83 56 92 M117 57 90 83 104 92 M80 47V115" />,
    <path key="crystal" d="M80 37 112 61 106 101 80 123 54 101 48 61Z M48 61 80 72 112 61 M54 101 80 72 106 101 M80 37V72L80 123" />,
    <path key="orbit" d="M80 51 105 66 105 96 80 111 55 96 55 66Z M80 51V81L105 96 M55 96 80 81 105 66 M55 66 80 81V111" />,
    <path key="sun" d="M80 40 91 61 114 58 107 80 120 98 97 102 80 121 63 102 40 98 53 80 46 58 69 61Z M80 64 96 80 80 96 64 80Z" />,
  ];
  return <svg className={`badge-art ${rarity} ${muted ? 'muted' : ''} ${large ? 'large' : ''}`} viewBox="0 0 160 172" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}-foil`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="currentColor" stopOpacity=".08" /><stop offset=".55" stopColor="currentColor" stopOpacity=".24" /><stop offset="1" stopColor="currentColor" stopOpacity=".06" /></linearGradient></defs>
    <path className="badge-ribbon" d="M53 116 41 163 65 154 79 168 91 117 M83 117 98 165 110 152 133 161 113 112" />
    <path fill={`url(#${id}-foil)`} stroke="currentColor" strokeWidth="1.5" d="M80 9 99 17 119 20 131 37 146 51 145 73 151 93 140 111 133 131 113 139 96 153 75 150 54 151 39 135 20 126 17 105 8 87 16 67 17 45 35 32 47 16 68 16Z" />
    <circle cx="80" cy="81" r="56" fill="none" stroke="currentColor" strokeOpacity=".35" />
    <circle cx="80" cy="81" r="48" fill="none" stroke="currentColor" strokeOpacity=".18" strokeDasharray="1 6" />
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">{motifs[variant]}</g>
    <g fill="currentColor"><circle cx="80" cy="19" r="2" /><circle cx="141" cy="81" r="2" /><circle cx="19" cy="81" r="2" /><circle cx="80" cy="143" r="2" /></g>
  </svg>;
}
