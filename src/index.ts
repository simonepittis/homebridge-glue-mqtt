import * as dns from 'dns';
dns.setServers( [ '1.1.1.1', '1.0.0.1' ] );

import axios, { AxiosInstance } from 'axios';
import { lockStateEnum } from './enum';
import { IGlueCommandResp, IGlueEventResponse, IGlueEventType, IGlueEventTypeResponse, IGlueHubsResponse, IGlueLockStatusResp } from './interface';

let service: any;
let characteristic: any;

interface IConfig {
    username: string;
    password: string;
    'hub-id'?: string;
    'lock-id'?: string;
    url?: string;
    name?: string;
    'check-for-events'?: boolean;
    'check-for-events-interval'?: number;
}

export default function( homebridge: any ) {
    service = homebridge.hap.Service;
    characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory( 'homebridge-glue', 'glue-lock', LockAccessory );
}

class LockAccessory {

    get name() {
        return this.config.name || 'Glue Lock';
    }
    get url() {
        return this.config.url || 'https://api.gluehome.com/api';
    }

    get checkEventsInterval() {
        return this.config['check-for-events-interval'] || 10;
    }
    get checkEventsIsEnabled() {
        return this.config['check-for-events'] || true;
    }

    get client(): AxiosInstance {
        return axios.create( {
            baseURL: this.url,
            auth: { username: this.config.username, password: this.config.password },
        } );
    }

    get lockStatus() {
        return lockStateEnum[this.currentStatusOfLock];
    }

    get currentStatusOfLock(): '1' | '0' {
        return this.currentStatusOfLockHolder;
    }
    set currentStatusOfLock( state ) {
        this.currentStatusOfLockHolder = state; // '1' or '0'.
        this.lastEventCheck = new Date();
        this.lockService.setCharacteristic( characteristic.LockCurrentState, state );
    }
    private hubID: string;
    private lockID: string;
    private currentStatusOfLockHolder: '0' | '1' = characteristic.ChargingState.UNKNOWN; // starts with unknown '3';
    private lastEventCheck: Date = new Date( 0 );
    private lockService: any = new service.LockMechanism( this.name );
    private batteryService: any = new service.BatteryService( this.name );
    private eventTypes: Promise<{ [eventTypeId: string]: IGlueEventType }>;

    constructor( private log: any, private readonly config: IConfig ) {
        if ( !this.config.username && !this.config.password ) throw new Error( `Config requires a username and password` );
        if ( !this.config.username ) throw new Error( `Config requires a username` );
        if ( !this.config.password ) throw new Error( `Config requires a password` );

        this.hubID = config['hub-id'];
        this.lockID = config['lock-id'];
        /* tslint:disable-next-line: no-floating-promises */
        this.init();
        this.listenToEvents();
    }

    public getServices() {
        return [this.lockService, this.batteryService];
    }

    public getCharging( callback: ( err: Error, resp?: any ) => void ) {
        callback( null, characteristic.ChargingState.NOT_CHARGING );
    }

    public getState( callback: ( err: Error, resp?: any ) => void ) {
        /* Only works if the status was last set by Homebridge or the Glue app NOT if manually unlocked or locked. */
        callback( null, characteristic.LockCurrentState[this.lockStatus] );
    }

    public async getBattery( callback: ( err: Error, resp?: number ) => void ) {
        return this.getBatteryLevel()
            .then( batteryLevel => callback( null, batteryLevel ) )
            .catch( err => callback( err ) );
    }

    public async getLowBattery( callback ) {
        return this.getBatteryLevel()
            .then( batteryLevel => ( batteryLevel >= 20 ) ? characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : characteristic.StatusLowBattery.BATTERY_LEVEL_LOW )
            .then( lowBattery => callback( null, lowBattery ) )
            .catch( err => callback( err ) );
    }

    public async setState( hubCommand: '1' | '0', callback: ( err: Error, resp?: any ) => void ) {
        this.log( 'Set state to %s', hubCommand === '1' ? 'locked' : 'unlocked' );
        await this.client.post<IGlueCommandResp>( `/Hubs/${this.hubID}/Commands`, {
            LockId: this.lockID,
            HubCommand: hubCommand,
        } ).then( resp => resp.data )
            .then( ( { Status } ) => {
                if ( Status === 1 ) { // Success
                    this.currentStatusOfLock = hubCommand;
                    callback( null );
                    return `State change completed and set to ${lockStateEnum[hubCommand]}.`;
                } else {
                    throw new Error( 'Error setting lock state.' );
                }
            } )
            .catch( err => { callback( err ); return err.message; } )
            .then( m => this.log( m ) );
    }

    private listenToEvents() {
        this.lockService
            .getCharacteristic( characteristic.LockCurrentState )
            .on( 'get', this.getState.bind( this ) );

        this.lockService
            .getCharacteristic( characteristic.LockTargetState )
            .on( 'get', this.getState.bind( this ) )
            .on( 'set', this.setState.bind( this ) );

        this.batteryService
            .getCharacteristic( characteristic.BatteryLevel )
            .on( 'get', this.getBattery.bind( this ) );

        this.batteryService
            .getCharacteristic( characteristic.StatusLowBattery )
            .on( 'get', this.getLowBattery.bind( this ) );
    }

    private async getEventTypes() {
        this.eventTypes = this.client.get<IGlueEventTypeResponse>( `/EventTypes` )
            .then( resp => resp.data )
            .then( events => events.reduce( ( acc, curr ) => ( { ...acc, [curr.Id]: curr } ), {} ) );
        await this.eventTypes;
        /* check for new types once an hour. */
        setTimeout( () => {
            /* tslint:disable-next-line: no-floating-promises */
            this.getEventTypes();
        }, 1 * 60 * 60 * 1000 );
        return this.eventTypes;
    }

    private async init() {
        this.log( 'Initalizing Glue Lock' );
        await this.getEventTypes();
        if ( !this.hubID || !this.lockID ) {
            await this.client.get<IGlueHubsResponse>( '/Hubs' )
                .then( resp => resp.data )
                .then( hubs => {
                    this.log( 'Available hubs and locks: ' );
                    hubs.forEach( hub => this.log( `hubId: ${hub.Id}, available lockIds: ${hub.LockIds}` ) );
                    this.log( `Will select the first hub and first lock, otherwise set it in config.json as: hub-id: '${hubs[0].Id}', lock-id: '${hubs[0].LockIds[0]}'` );
                    this.hubID = hubs[0].Id;
                    this.lockID = hubs[0].LockIds[0];
                } )
                .catch( err => this.log( `Got error: ${err.message} from ${this.client.defaults.baseURL}/Hubs` ) );
        }
        await this.checkEvents(); // get last known state from Glue.
        if ( this.checkEventsIsEnabled ) {
            setInterval( () => this.checkEvents(),
                this.checkEventsInterval * 1000 );
        }
    }

    private async getBatteryLevel() {
        return this.client.get<IGlueLockStatusResp>( `/Locks/${this.lockID}` )
            .then( resp => resp.data.BatteryStatusAfter || resp.data.BatteryStatusBefore )
            .then( batteryStatus => batteryStatus / 255 * 100 )
            .then( batteryLevel => { this.log( `Battery level is ${batteryLevel}` ); return batteryLevel; } )
            .catch( err => this.log( `Error getting battery level (status code ${( err.response || {} ).status}): '${err.message}'.` ) );
    }

    private async checkEvents() {
        await this.client.get<IGlueEventResponse>( '/Events/' )
            .then( ( resp ) => resp.data.LockEvent.filter( ( { LockId, Created } ) => LockId === this.lockID && new Date( Created + 'Z' ) > this.lastEventCheck ) )
            .then( events => events[0] )
            .then( ( { EventTypeId } ) => this.eventTypes.then( types => { this.log( types ); return types[EventTypeId]} ) )
                .then( type => type.Description ) // Locked or Unlocked
            .then( event => { this.log( `Setting status to ${event}` ); return event; } )
            .then( eventAction => this.currentStatusOfLock = lockStateEnum[eventAction] )
            .catch( _e => undefined );
    }
}
