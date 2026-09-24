FROM node:22-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM maven:3.9.11-eclipse-temurin-21 AS backend
WORKDIR /build/backend
COPY backend/ ./
COPY docker/maven-settings.xml /tmp/maven-settings.xml
COPY --from=frontend /build/frontend/dist/ src/main/resources/static/
RUN mvn -s /tmp/maven-settings.xml -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd -r databridge && useradd -r -g databridge databridge
COPY --from=backend /build/backend/target/databridge-0.1.0.jar app.jar
USER databridge
EXPOSE 8080
ENTRYPOINT ["java","-jar","/app/app.jar"]
