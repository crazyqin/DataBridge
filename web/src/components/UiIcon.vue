<script setup lang="ts">
defineProps<{ name: 'bridge' | 'overview' | 'apis' | 'rows' | 'logs' | 'connections' | 'sources' | 'keys' | 'plus' | 'refresh' | 'search' | 'arrow' | 'chevron' | 'user' | 'logout' | 'activity' }>()
const paths: Record<string, string> = {
  bridge: 'M3 18h18M4 18V9m16 9V9M4 12c4-7 12-7 16 0M8 18v-9m4 9V7m4 11v-9',
  overview: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  apis: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16',
  rows: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM4 9h16M9 9v11M4 14h16',
  logs: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 12h8m-8 4h5',
  connections: 'm10 13 4-4m-5 6-1 1a4 4 0 0 1-6-6l3-3a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-3 3a4 4 0 0 1-6 0',
  sources: 'M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3ZM4 6v6c0 2 4 3 8 3s8-1 8-3V6M4 12v6c0 2 4 3 8 3s8-1 8-3v-6',
  keys: 'M14 4a5 5 0 1 1-2 9l-7 7H2v-3l7-7a5 5 0 0 1 5-6Zm2 3h.01M5 17l2 2',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  chevron: 'm9 5 7 7-7 7',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  logout: 'M9 4H4v16h5m5-12 4 4-4 4m-5-4h12',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
}
</script>

<template>
  <svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path :d="paths[name]" /></svg>
</template>
