FROM node:20-alpine

# create app directory
WORKDIR /usr/src/app

# install app dependencies
COPY package*.json ./
RUN npm install --only=production

# bundle app source
COPY . .

# expose the port configured in .env (default 3000)
EXPOSE 3000

CMD ["npm", "start"]