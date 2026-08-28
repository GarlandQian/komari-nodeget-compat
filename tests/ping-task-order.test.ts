import type { KomariPingTask } from '../src/types'
import { describe, expect, it } from 'bun:test'
import { rankPingTasks } from '../src/nodeget/ping-task-order'

function task(id: number, name: string, type = 'ping', clients = ['node-a']): KomariPingTask {
  return {
    id,
    name,
    type,
    clients,
    default_on: true,
    interval: 60,
  }
}

function automaticDefaults(tasks: KomariPingTask[]): KomariPingTask[] {
  return rankPingTasks(tasks)
    .sort((left, right) => (left.weight ?? left.id) - (right.weight ?? right.id) || left.id - right.id)
    .slice(0, 3)
}

describe('Ping task ordering', () => {
  it('prefers a complete city carrier group and orders telecom, unicom, then mobile', () => {
    const defaults = automaticDefaults([
      task(11, 'ping-广东移动'),
      task(12, 'ping-广东电信'),
      task(13, 'ping-广东联通'),
      task(23, 'ping-海滨移动'),
      task(21, 'ping-中国电信-海滨'),
      task(22, 'ping-海滨联通'),
    ])

    expect(defaults.map(item => item.name)).toEqual([
      'ping-中国电信-海滨',
      'ping-海滨联通',
      'ping-海滨移动',
    ])
  })

  it('falls back to a complete province group when the city group is incomplete', () => {
    const defaults = automaticDefaults([
      task(23, 'tcping-海滨移动', 'tcp_ping'),
      task(21, 'tcping-海滨电信', 'tcp_ping'),
      task(11, 'tcping-广东移动', 'tcp_ping'),
      task(12, 'tcping-广东电信', 'tcp_ping'),
      task(13, 'tcping-广东联通', 'tcp_ping'),
    ])

    expect(defaults.map(item => item.name)).toEqual([
      'tcping-广东电信',
      'tcping-广东联通',
      'tcping-广东移动',
    ])
  })

  it('uses task-family size and coverage when no complete carrier group exists', () => {
    const defaults = automaticDefaults([
      task(1, 'route-alpha', 'ping'),
      task(2, 'route-beta', 'ping'),
      task(3, 'route-gamma', 'tcp_ping'),
      task(4, 'route-delta', 'tcp_ping'),
      task(5, 'route-epsilon', 'tcp_ping'),
    ])

    expect(defaults.map(item => item.type)).toEqual(['tcp_ping', 'tcp_ping', 'tcp_ping'])
  })
})
