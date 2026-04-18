import { ElMessage } from 'element-plus'
import { authorizedDevices, type Device } from '../types'
import type { IDevice, DeviceInfo, BluetoothConfig } from '../types'
import { ConfigManager } from '../../utils/ConfigManager'

const configManager = ConfigManager.getInstance()
const bluetoothConfig = configManager.useConfig('bluetooth')

// 常见的 BLE 串口服务 UUID 列表
const COMMON_BLE_SERVICES = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic NUS
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10, CC2541, JDY-08
  '0000fff0-0000-1000-8000-00805f9b34fb', // 常见透传 1
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // IS1678S
  '0000ffe1-0000-1000-8000-00805f9b34fb', // 某些设备用 E1 作为 Service
]

// BLE 单次写入最大字节数 (默认 MTU - 3)
const BLE_MAX_WRITE_SIZE = 20

export class BluetoothDeviceImpl implements IDevice {
  id: string
  title: string
  type: string = 'bluetooth'
  port: BluetoothDevice

  private server: BluetoothRemoteGATTServer | null = null
  private txCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  private rxCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  private disconnectHandler: (() => void) | null = null

  constructor(port: BluetoothDevice) {
    this.port = port
    this.id = BluetoothDeviceImpl.getDeviceId(port)
    this.title = BluetoothDeviceImpl.getDeviceTitle(port)
  }

  static getDeviceTitle(port: BluetoothDevice): string {
    return port.name || '未知蓝牙设备'
  }

  static getDeviceId(port: BluetoothDevice): string {
    return `bluetooth_${port.id}`
  }

  static async init(): Promise<void> {
  }

  static async request(): Promise<Device | null> {
    try {
      if (!navigator.bluetooth) {
        ElMessage.error('浏览器不支持Web Bluetooth API')
        return null
      }
      
      const serviceUuid = bluetoothConfig.value?.serviceUuid || '6e400001-b5a3-f393-e0a9-e50e24dcca9e'

      // 将用户自定义的 UUID 和常见 UUID 都加入白名单，防止不可见
      const allServices = [...COMMON_BLE_SERVICES, serviceUuid]
      const optionalServices = allServices.filter((v, i, a) => a.indexOf(v) === i)

      const port = await navigator.bluetooth.requestDevice({
        // acceptAllDevices: true 时必须通过 optionalServices 声明要访问的 Service
        acceptAllDevices: true,
        optionalServices
      })
      const device = new BluetoothDeviceImpl(port)
      return device as unknown as Device
    } catch (error: any) {
      if (error.message !== "User cancelled the requestDevice() chooser.") {
        ElMessage.error('蓝牙设备连接失败：' + error)
      }
      console.error(error)
    }
    return null
  }

  async connect(): Promise<{ 
    writer: WritableStreamDefaultWriter, 
    reader: ReadableStreamDefaultReader 
  } | null> {
    try {
      if (!this.port.gatt) {
        ElMessage.error('该蓝牙设备不支持 GATT')
        return null
      }

      console.log('Connecting to Bluetooth device:', this.title)

      // 1. 连接 GATT Server
      this.server = await this.port.gatt.connect()
      console.log('GATT server connected')

      const configuredServiceUuid = bluetoothConfig.value?.serviceUuid || '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
      const configuredRxUuid = bluetoothConfig.value?.rxUuid || '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
      const configuredTxUuid = bluetoothConfig.value?.txUuid || '6e400003-b5a3-f393-e0a9-e50e24dcca9e'

      // 2. 尝试获取所有可用（已被 optionalServices 允许）的服务
      let services: BluetoothRemoteGATTService[] = []
      try {
        services = await this.server.getPrimaryServices()
      } catch (e) {
        console.error('获取服务列表失败', e)
        ElMessage.error('获取设备服务能力失败')
        this.server.disconnect()
        this.server = null
        return null
      }

      console.log('Available services:', services.map(s => s.uuid))

      // 3. 寻找匹配的 Service
      let targetService: BluetoothRemoteGATTService | undefined
      
      // 优先尝试使用用户配置的 serviceUuid
      targetService = services.find(s => s.uuid === configuredServiceUuid)
      
      if (!targetService) {
        // 如果配置的找不到，尝试内置支持的其他常见 UUID
        targetService = services.find(s => COMMON_BLE_SERVICES.includes(s.uuid))
      }

      if (!targetService) {
        ElMessage.error(`未找到支持的透传服务，设备开放的服务有: \n${services.map(s=>s.uuid.split('-')[0]).join(',\n')}`)
        this.server.disconnect()
        this.server = null
        return null
      }
      
      console.log('Target service selected:', targetService.uuid)

      // 4. 获取该服务下的所有 Characteristics，以便智能找寻 RX/TX
      const characteristics = await targetService.getCharacteristics()
      console.log('Available characteristics:', characteristics.map(c => c.uuid))

      // 5. 寻找 TX Characteristic (设备发给主机，需具有 Notify/Indicate 属性)
      // 优先匹配配置里的 TX UUID，没有则寻找第一个带 notify 的
      let txChar = characteristics.find(c => c.uuid === configuredTxUuid)
      if (!txChar) {
        txChar = characteristics.find(c => c.properties.notify || c.properties.indicate)
      }

      // 6. 寻找 RX Characteristic (主机发给设备，需具有 Write/WriteWithoutResponse 属性)
      // 优先匹配配置里的 RX UUID，没有则寻找第一个带 write 的
      let rxChar = characteristics.find(c => c.uuid === configuredRxUuid)
      if (!rxChar) {
        rxChar = characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse)
      }

      if (!txChar || !rxChar) {
        ElMessage.error(`未找到具有收发能力的特征 (RX/TX)`)
        this.server.disconnect()
        this.server = null
        return null
      }

      this.txCharacteristic = txChar
      this.rxCharacteristic = rxChar

      console.log('TX characteristic selected:', this.txCharacteristic.uuid)
      console.log('RX characteristic selected:', this.rxCharacteristic.uuid)

      // 7. 启用 TX 通知
      try {
        await this.txCharacteristic.startNotifications()
        console.log('TX notifications started')
      } catch (e) {
        ElMessage.error('无法监听设备的通知 (startNotifications 失败)')
        throw e
      }

      // 8. 监听断线事件
      this.disconnectHandler = () => {
        console.log('Bluetooth device disconnected:', this.title)
        this.cleanup()
      }
      this.port.addEventListener('gattserverdisconnected', this.disconnectHandler)

      // 9. 更新配置里实际成功使用的 UUID（方便用户查看和记忆）
      if (configManager.useConfig('bluetooth').value) {
        configManager.useConfig('bluetooth').value.serviceUuid = targetService.uuid
        configManager.useConfig('bluetooth').value.txUuid = this.txCharacteristic.uuid
        configManager.useConfig('bluetooth').value.rxUuid = this.rxCharacteristic.uuid
      }

      // 10. 返回 writer / reader 适配器
      return {
        writer: new BLEWriter(this.rxCharacteristic) as unknown as WritableStreamDefaultWriter,
        reader: new BLEReader(this.txCharacteristic) as unknown as ReadableStreamDefaultReader
      }
    } catch (error) {
      ElMessage.error('蓝牙连接失败：' + error)
      console.error(error)
      this.cleanup()
    }
    return null
  }

  async disconnect(): Promise<void> {
    try {
      console.log('Disconnecting Bluetooth device:', this.title)
      
      // 停止通知
      if (this.txCharacteristic) {
        try {
          await this.txCharacteristic.stopNotifications()
        } catch (e) {
          console.warn('停止通知失败:', e)
        }
      }

      // 断开 GATT
      if (this.server && this.server.connected) {
        this.server.disconnect()
      }
      
      this.cleanup()
    } catch (error) {
      ElMessage.error('断开蓝牙设备失败：' + error)
      console.error(error)
    }
  }

  private cleanup() {
    if (this.disconnectHandler) {
      this.port.removeEventListener('gattserverdisconnected', this.disconnectHandler)
      this.disconnectHandler = null
    }
    this.server = null
    this.txCharacteristic = null
    this.rxCharacteristic = null
  }

  getInfo(): DeviceInfo {
    return {
      productName: this.port.name
    }
  }
  
  async request(): Promise<IDevice | null> {
    return BluetoothDeviceImpl.request()
  }
}

/**
 * BLE 写入适配器
 * 封装 GATT Characteristic 的 writeValue，自动分包处理
 */
class BLEWriter {
  private characteristic: BluetoothRemoteGATTCharacteristic

  constructor(characteristic: BluetoothRemoteGATTCharacteristic) {
    this.characteristic = characteristic
  }

  async write(data: any): Promise<void> {
    let bytes: Uint8Array
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data)
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer)
    } else {
      bytes = new Uint8Array(data)
    }

    // BLE MTU 限制，需要分包发送
    for (let offset = 0; offset < bytes.length; offset += BLE_MAX_WRITE_SIZE) {
      const chunk = bytes.slice(offset, offset + BLE_MAX_WRITE_SIZE)
      // 优先使用 writeValueWithoutResponse（更快），不支持则使用 writeValue
      if (this.characteristic.properties.writeWithoutResponse) {
        await this.characteristic.writeValueWithoutResponse(chunk)
      } else {
        await this.characteristic.writeValue(chunk)
      }
    }
  }

  async close(): Promise<void> {
    // BLE 无需显式关闭写通道
  }

  async abort(): Promise<void> {
    // BLE 无需显式 abort
  }

  releaseLock(): void {
    // 兼容 WritableStreamDefaultWriter 接口
  }
}

/**
 * BLE 读取适配器
 * 监听 GATT Characteristic 的 notifications，将数据缓冲后通过 read() 返回
 */
class BLEReader {
  private characteristic: BluetoothRemoteGATTCharacteristic
  private buffer: Uint8Array[] = []
  private resolveWaiting: ((result: { done: boolean; value?: Uint8Array }) => void) | null = null
  private done = false
  private listener: ((event: any) => void) | null = null

  constructor(characteristic: BluetoothRemoteGATTCharacteristic) {
    this.characteristic = characteristic
    
    // 监听 BLE 通知数据
    this.listener = (event: any) => {
      const value = new Uint8Array(event.target.value.buffer)
      if (this.resolveWaiting) {
        // 有正在等待的 read() 调用，直接返回
        const resolve = this.resolveWaiting
        this.resolveWaiting = null
        resolve({ done: false, value })
      } else {
        // 没有等待的 read()，缓冲数据
        this.buffer.push(value)
      }
    }
    this.characteristic.addEventListener('characteristicvaluechanged', this.listener)
  }

  async read(): Promise<{ done: boolean; value?: Uint8Array }> {
    if (this.done) {
      return { done: true }
    }

    // 缓冲区有数据，直接返回
    if (this.buffer.length > 0) {
      return { done: false, value: this.buffer.shift()! }
    }

    // 等待下一次通知
    return new Promise((resolve) => {
      this.resolveWaiting = resolve
    })
  }

  cancel(): void {
    this.done = true
    if (this.listener) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.listener)
      this.listener = null
    }
    // 如果有正在等待的 read()，返回 done
    if (this.resolveWaiting) {
      this.resolveWaiting({ done: true })
      this.resolveWaiting = null
    }
  }

  releaseLock(): void {
    // 兼容 ReadableStreamDefaultReader 接口
  }
}

export const init = () => BluetoothDeviceImpl.init()
export const request = () => BluetoothDeviceImpl.request()
