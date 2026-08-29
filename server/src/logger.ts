import { pino } from 'pino'
import { config } from './config.js'

export const logger = pino({
	level: config.logLevel,
	...(config.logPretty
		? {
				transport: {
					target: 'pino-pretty',
					options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
				}
			}
		: {})
})

export type Logger = typeof logger
