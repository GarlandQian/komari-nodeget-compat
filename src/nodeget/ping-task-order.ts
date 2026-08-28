import type { KomariPingTask } from '../types'

interface CarrierDefinition {
  patterns: RegExp[]
}

interface TaskCandidate {
  task: KomariPingTask
  carrierIndex: number
  location: string
  level: 'city' | 'province' | 'other'
}

interface CompleteRouteGroup {
  tasks: [KomariPingTask, KomariPingTask, KomariPingTask]
  location: string
  level: 'city' | 'province'
  commonClientCount: number
  totalClientCount: number
  firstTaskId: number
}

const CARRIERS: CarrierDefinition[] = [
  { patterns: [/(?:中国)?电信/u, /\b(?:china[\s_-]*)?telecom\b/i, /\bct(?:cc)?\b/i] },
  { patterns: [/(?:中国)?联通/u, /\b(?:china[\s_-]*)?unicom\b/i, /\bcu(?:cc)?\b/i] },
  { patterns: [/(?:中国)?移动/u, /\b(?:china[\s_-]*)?mobile\b/i, /\bcm(?:cc)?\b/i] },
]

const PROVINCE_LEVEL_LOCATIONS = new Set([
  '河北',
  '山西',
  '辽宁',
  '吉林',
  '黑龙江',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '海南',
  '四川',
  '贵州',
  '云南',
  '陕西',
  '甘肃',
  '青海',
  '台湾',
  '内蒙古',
  '广西',
  '西藏',
  '宁夏',
  '新疆',
  'hebei',
  'shanxi',
  'liaoning',
  'jilin',
  'heilongjiang',
  'jiangsu',
  'zhejiang',
  'anhui',
  'fujian',
  'jiangxi',
  'shandong',
  'henan',
  'hubei',
  'hunan',
  'guangdong',
  'hainan',
  'sichuan',
  'guizhou',
  'yunnan',
  'shaanxi',
  'gansu',
  'qinghai',
  'taiwan',
  'neimenggu',
  'innermongolia',
  'guangxi',
  'xizang',
  'tibet',
  'ningxia',
  'xinjiang',
])

const BROAD_LOCATIONS = new Set([
  '全国',
  '中国',
  '国内',
  '全网',
  'china',
  'cn',
  'global',
  'default',
  'all',
])

function normalizeLocation(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?:tcp[\s_-]*ping|tcping|icmp|ping)/giu, ' ')
    .replace(/(?:ipv?[46]|v[46])/giu, ' ')
    .replace(/[\s\-_.:/()[\]{}]+/g, '')
    .replace(/(?:壮族|回族|维吾尔)?自治区$/u, '')
    .replace(/特别行政区$/u, '')
    .replace(/[省市]$/u, '')
    .replace(/(?:province|city)$/i, '')
}

function locationLevel(location: string): TaskCandidate['level'] {
  if (!location || BROAD_LOCATIONS.has(location))
    return 'other'
  return PROVINCE_LEVEL_LOCATIONS.has(location) ? 'province' : 'city'
}

function taskCandidate(task: KomariPingTask): TaskCandidate | null {
  const normalizedName = task.name.normalize('NFKC').toLowerCase()
  for (const [carrierIndex, carrier] of CARRIERS.entries()) {
    for (const pattern of carrier.patterns) {
      const match = pattern.exec(normalizedName)
      if (!match || match.index === undefined)
        continue
      const withoutCarrier = normalizedName.slice(0, match.index)
        + normalizedName.slice(match.index + match[0].length)
      const location = normalizeLocation(withoutCarrier)
      return { task, carrierIndex, location, level: locationLevel(location) }
    }
  }
  return null
}

function uniqueClientCount(tasks: KomariPingTask[]): number {
  return new Set(tasks.flatMap(task => task.clients)).size
}

function commonClientCount(tasks: KomariPingTask[]): number {
  const [first, ...rest] = tasks
  if (!first)
    return 0
  const common = new Set(first.clients)
  for (const task of rest) {
    const clients = new Set(task.clients)
    for (const client of common) {
      if (!clients.has(client))
        common.delete(client)
    }
  }
  return common.size
}

function completeRouteGroups(tasks: KomariPingTask[]): CompleteRouteGroup[] {
  const groups = new Map<string, TaskCandidate[]>()
  for (const task of tasks) {
    const candidate = taskCandidate(task)
    if (!candidate || candidate.level === 'other')
      continue
    const key = `${task.type}\u0000${candidate.level}\u0000${candidate.location}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  return [...groups.values()].flatMap((candidates): CompleteRouteGroup[] => {
    const selected = CARRIERS.map((_, carrierIndex) => candidates
      .filter(candidate => candidate.carrierIndex === carrierIndex)
      .sort((left, right) => (
        right.task.clients.length - left.task.clients.length || left.task.id - right.task.id
      ))[0]?.task)
    if (!selected.every((task): task is KomariPingTask => Boolean(task)))
      return []
    const routeTasks = selected as [KomariPingTask, KomariPingTask, KomariPingTask]
    const commonClients = commonClientCount(routeTasks)
    if (!commonClients)
      return []
    const first = candidates[0]!
    return [{
      tasks: routeTasks,
      location: first.location,
      level: first.level as 'city' | 'province',
      commonClientCount: commonClients,
      totalClientCount: uniqueClientCount(routeTasks),
      firstTaskId: Math.min(...routeTasks.map(task => task.id)),
    }]
  })
}

function familyWeights(tasks: KomariPingTask[]): Map<string, number> {
  const groups = new Map<string, KomariPingTask[]>()
  for (const task of tasks) {
    const group = groups.get(task.type) ?? []
    group.push(task)
    groups.set(task.type, group)
  }
  const rankedTypes = [...groups.entries()]
    .map(([type, typeTasks]) => ({
      type,
      taskCount: typeTasks.length,
      clientCount: uniqueClientCount(typeTasks),
      firstTaskId: Math.min(...typeTasks.map(task => task.id)),
    }))
    .sort((left, right) => (
      right.taskCount - left.taskCount
      || right.clientCount - left.clientCount
      || left.firstTaskId - right.firstTaskId
    ))
  return new Map(rankedTypes.map((entry, index) => [entry.type, index]))
}

export function rankPingTasks(tasks: KomariPingTask[]): KomariPingTask[] {
  const routeGroups = completeRouteGroups(tasks)
  const cityGroups = routeGroups.filter(group => group.level === 'city')
  const eligibleGroups = cityGroups.length
    ? cityGroups
    : routeGroups.filter(group => group.level === 'province')
  const preferred = eligibleGroups.sort((left, right) => (
    right.commonClientCount - left.commonClientCount
    || right.totalClientCount - left.totalClientCount
    || left.firstTaskId - right.firstTaskId
    || left.location.localeCompare(right.location)
  ))[0]
  const fallbackWeights = familyWeights(tasks)

  if (!preferred) {
    return tasks.map(task => ({
      ...task,
      weight: fallbackWeights.get(task.type) ?? fallbackWeights.size,
    }))
  }

  const preferredWeights = new Map(preferred.tasks.map((task, index) => [task.id, index]))
  return tasks.map(task => ({
    ...task,
    weight: preferredWeights.get(task.id)
      ?? 3 + (fallbackWeights.get(task.type) ?? fallbackWeights.size),
  }))
}
