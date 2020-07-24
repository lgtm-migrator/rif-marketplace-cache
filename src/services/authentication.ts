import { ServiceAddons, Params } from '@feathersjs/feathers';
import { AuthenticationService, JWTStrategy, AuthenticationResult, AuthenticationBaseStrategy } from '@feathersjs/authentication';
import { Application } from '../definitions';

declare module '../definitions' {
    interface ServiceTypes {
        'authentication': AuthenticationService & ServiceAddons<any>;
    }
}

class MyJWT extends JWTStrategy {
    async authenticate(authentication: AuthenticationResult, params: Params) {
        console.log('MyJWT -> authenticate------------------------------')
        console.log(authentication)
        console.log('------------------------------')
        console.log(params)
        console.log('------------------------------')
        return super.authenticate(authentication, params)
    }
}
class AnonymousStrategy extends AuthenticationBaseStrategy {
    async authenticate(authentication, params) {
        const channels: [] = authentication.channels
        console.log('AnonymousStrategy -> authenticate------------------------------')
        console.log(authentication)
        console.log('------------------------------')
        params.connection.ownerAddress = authentication.ownerAddress
        channels.forEach(channel => {
            this.app?.channel(channel).join(params.connection)
        });
        console.log('this.app.channels:', this.app.channels)
        console.log('------------------------------')
        return {
            anonymous: true
        }
    }
}

class MyAuthService extends AuthenticationService {
    async getPayload(authResult, params) {
        // Call original `getPayload` first
        const payload = await super.getPayload(authResult, params);
        const { user } = authResult;

        if (user && user.permissions) {
            payload.permissions = user.permissions;
        }

        return payload;
    }
}

export default function (app: Application) {
    const authentication = new MyAuthService(app as any) //FIXME: remove `as any`

    app.set('authentication', {
        "secret": "8a58b86565c23c9ea90",
        "entity": null,
        "authStrategies": ["anonymous"],
    })

    authentication.register('anonymous', new AnonymousStrategy());
    // authentication.register('jwt', new MyJWT());

    app.use('/authentication', authentication);
}